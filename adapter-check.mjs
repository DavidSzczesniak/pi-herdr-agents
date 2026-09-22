// Pi and Herdr behavior is stubbed here. Files, Unix sockets, and Linux process identity are real.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import adapter from "./index.ts";
import { atomicWrite, request } from "./protocol.ts";
import { socketDirectory } from "./startup.ts";
import { claimLaunch, isOriginalProcessLive, processIdentity, planLines, tabPane, verifySession, thinking } from "./runtime.ts";

const directory = mkdtempSync(join(tmpdir(), "piha-adapter-"));
const state = directory;
const originalEnv = { ...process.env };
const fixtures = [];
let processProbe;
const pane = (id = "w1:p1") => ({ pane_id: id, workspace_id: "w1", terminal_id: `term-${id}`, tab_id: `tab-${id}` });
const header = { type: "session", version: 3, id: "session-lead", timestamp: new Date().toISOString(), cwd: directory };

function fixture({ workerId = "lead", role = "lead", parentId = "", auth = true, mode = "started", restart = "", sessionId = `session-${workerId}`, failReport = false, launchFault = "", launchId = "" } = {}) {
  Object.assign(process.env, { DS_HERDR_STATE_DIR: state, DS_HERDR_SESSION: "slice", DS_HERDR_WORKSPACE: directory,
    DS_HERDR_WORKER_ID: workerId, DS_HERDR_ROLE: role, DS_HERDR_PARENT_ID: parentId, DS_HERDR_RESTART_GENERATION: restart,
    HERDR_ENV: "1", HERDR_SESSION_NAME: "slice", HERDR_SOCKET_PATH: "/fixture/herdr.sock", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: `w1:p-${workerId}` });
  delete process.env.DS_HERDR_WORKSPACE_ID;
  process.env.DS_HERDR_LAUNCH_ID = launchId;
  const hooks = new Map();
  const tools = new Map();
  const commands = [];
  const widgets = new Map();
  let selectedTools = ["read", "bash", "external_evidence"];
  let startupError;
  let effort = "high";
  let idle = true;
  let shutdowns = 0;
  let sends = 0;
  let runSignal;
  let spawned;
  let abortController;
  const sessionFile = join(state, `${workerId}.jsonl`);
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ ...header, id: sessionId }) + "\n");
  const ctx = {
    cwd: directory, mode: "tui", hasUI: true, get signal() { return runSignal; },
    model: { provider: "fixture", id: "no-network" },
    modelRegistry: { hasConfiguredAuth: () => auth, getProviderAuthStatus: () => ({ configured: auth }) },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId },
    isIdle: () => idle, hasPendingMessages: () => false,
    abort: () => abortController?.abort(), shutdown: () => { shutdowns++; },
    ui: { notify(message) { startupError = message; }, setWidget(key, lines) { widgets.set(key, lines); } },
  };
  const emit = async (name, event = {}) => { for (const callback of hooks.get(name) ?? []) await callback(event, ctx); };
  const api = {
    on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls", "external_evidence", ...tools.keys()].map(name => ({ name })),
    getActiveTools: () => selectedTools, setActiveTools: names => { selectedTools = names; },
    getThinkingLevel: () => effort, setThinkingLevel: level => { effort = level; },
    appendEntry(type, data) { writeFileSync(sessionFile, JSON.stringify({ type: "custom", customType: type, data }) + "\n", { flag: "a" }); },
    async exec(_command, args) {
      assert.equal(_command, "env");
      assert.ok(args.includes("HERDR_SOCKET_PATH=/fixture/herdr.sock"));
      const op = args.slice(args.indexOf("herdr") + 1);
      commands.push(["--session", "slice", ...op]);
      if (op[0] === "tab" && op[1] === "create") {
        spawned = pane("w1:new");
        if (launchFault === "unknown-create") return { code: 1, killed: true, stderr: "fixture receipt lost", stdout: "" };
        if (launchFault === "abort-after-create") abortController.abort();
        return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ result: { root_pane: spawned } }) };
      }
      if (op[0] === "agent" && op[1] === "start") return { code: 1, killed: false, stderr: "fixture startup failure", stdout: "" };
      if (op[0] === "pane" && op[1] === "get") return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ result: { pane: op[2] === "w1:new" ? spawned : pane(op[2]) } }) };
      if (failReport && op[1] === "release-agent") throw new Error("fixture report failure");
      return { code: 0, killed: false, stderr: "", stdout: "" };
    },
    sendUserMessage(text) {
      sends++;
      void (async () => {
        await emit("input", { source: "extension", text });
        if (mode !== "started") return;
        await emit("before_agent_start", { prompt: text, systemPromptOptions: { promptGuidelines: [] } });
        idle = false;
        abortController = new AbortController();
        runSignal = abortController.signal;
        await emit("agent_start");
      })();
    },
  };
  adapter(api);
  const instance = {
    tools, commands, widgets, ctx, emit, sessionFile,
    get sends() { return sends; }, get shutdowns() { return shutdowns; }, get effort() { return effort; }, get activeTools() { return selectedTools; },
    setAbort(controller) { abortController = controller; },
    async start(reason = "startup") { await emit("session_start", { reason }); if (startupError) throw new Error(startupError); return JSON.parse(readFileSync(join(state, "workers", `${workerId}.json`))); },
    async settle() { await emit("agent_before_settle", { outcome: "completed" }); idle = true; await emit("agent_settled"); },
    async stop() { await emit("session_shutdown"); },
  };
  fixtures.push(instance);
  return instance;
}
const selfRequest = (identity, operation) => request(identity.socketPath, { callerId: identity.workerId, callerGeneration: identity.generation, generation: identity.generation, ...operation });
try {
  const current = processIdentity(process.pid);
  assert.ok(current);
  assert.equal(isOriginalProcessLive({ pid: process.pid, pidBirth: current.birth }), true);
  assert.equal(isOriginalProcessLive({ pid: process.pid, pidBirth: "different-birth" }), false);
  assert.equal(thinking("judgment"), "high");
  assert.equal(thinking("review"), "medium");
  assert.equal(thinking("explore"), "low");
  assert.throws(() => tabPane({ result: { root_pane: pane() } }, "other"), /workspace/);
  assert.deepEqual(tabPane({ result: { root_pane: pane() } }, "w1"), pane());
  assert.equal(planLines({ plan: [{ step: "  Verbatim\nstep.  ", status: "in_progress" }] })[0], "[>]   Verbatim\nstep.  ");

  const root = fixture({ auth: false });
  const lead = await root.start();
  assert.equal(root.effort, "high", "lead launcher thinking preserved");
  assert.ok(root.activeTools.includes("external_evidence"));
  const noauth = await selfRequest(lead, { kind: "submit", submissionId: "noauth", task: "not executed" });
  assert.equal(noauth.kind, "unavailable");
  assert.equal(root.sends, 0);
  assert.equal((await selfRequest(lead, { kind: "status" })).active, null);
  await assert.rejects(selfRequest(lead, { kind: "submit", submissionId: "noauth", task: "duplicate" }), /Duplicate/);
  await root.tools.get("update_plan").execute("p1", { plan: [{ step: "  exact step  ", status: "pending" }] }, undefined, undefined, root.ctx);
  const leadPlan = readFileSync(join(state, "plans", "lead.json"), "utf8");
  assert.equal(JSON.parse(leadPlan).plan[0].step, "  exact step  ");

  const reviewer = fixture({ workerId: "reviewer", role: "review", parentId: "lead", failReport: true });
  const review = await reviewer.start();
  assert.equal(reviewer.effort, "medium");
  for (const name of ["bash", "edit", "write", "update_plan", "spawn_agent"]) assert.ok(reviewer.activeTools.includes(name));
  await reviewer.tools.get("update_plan").execute("p2", { plan: [{ step: "review", status: "completed" }] }, undefined, undefined, reviewer.ctx);
  assert.equal(readFileSync(join(state, "plans", "lead.json"), "utf8"), leadPlan, "worker plan leaves lead plan unchanged");
  const accepted = await selfRequest(review, { kind: "submit", submissionId: "started", task: "run" });
  assert.equal(accepted.kind, "accepted");
  assert.equal(accepted.evidence, "agent_start");
  await assert.rejects(selfRequest(review, { kind: "submit", submissionId: "concurrent", task: "run" }), /busy/);
  await reviewer.settle();
  const settled = await selfRequest(review, { kind: "wait", submissionId: "started", timeoutMs: 10 });
  assert.equal(settled.kind, "settled");
  assert.equal(settled.outcome, "completed");
  await assert.rejects(request(review.socketPath, { callerId: "lead", callerGeneration: lead.generation, generation: "wrong", kind: "status" }), /Stale target/);
  await reviewer.stop();
  assert.equal(existsSync(review.socketPath), false, "release-agent failure still removes socket");

  const modelOwner = fixture({ workerId: "model-owner", role: "implement", parentId: "lead" });
  const originalModelOwner = await modelOwner.start();
  assert.deepEqual(originalModelOwner.model, { provider: "fixture", id: "no-network" });
  const selectedModel = { provider: "another-provider", id: "human-selected-model" };
  modelOwner.ctx.model = selectedModel;
  await modelOwner.emit("model_select", { model: selectedModel, source: "set" });
  await modelOwner.stop();
  const deadModelOwner = JSON.parse(readFileSync(join(state, "workers", "model-owner.json")));
  assert.deepEqual(deadModelOwner.model, selectedModel, "native model_select persists current authoritative model");
  assert.ok(!readFileSync(modelOwner.sessionFile, "utf8").includes('"type":"message"'), "preflight-only session has no messages");
  atomicWrite(join(state, "workers", "model-owner.json"), { ...deadModelOwner, pidBirth: "dead-previous-process" });
  await assert.rejects(root.tools.get("followup_task").execute("model-revive", { agent_id: "model-owner", task: "new task only" }, undefined, undefined, root.ctx), /fixture startup failure/);
  const modelStart = root.commands.find(args => args[2] === "agent" && args[3] === "start");
  assert.equal(modelStart[modelStart.indexOf("--model") + 1], "another-provider/human-selected-model");
  assert.ok(existsSync(join(state, "locks", "launch-model-owner", "claim.json")), "unconfirmed native process retains launch fence");
  const startsBeforeRetry = root.commands.length;
  await assert.rejects(root.tools.get("followup_task").execute("model-retry", { agent_id: "model-owner", task: "retry forbidden" }, undefined, undefined, root.ctx), /EEXIST/);
  assert.equal(root.commands.length, startsBeforeRetry, "unresolved fence blocks retry before Herdr or session open");
  const wrongModel = fixture({ workerId: "model-owner", role: "implement", parentId: "lead", restart: deadModelOwner.generation });
  await assert.rejects(wrongModel.start(), /original Pi session required/, "startup refuses model fallback instead of silently changing it");

  const claimed = fixture({ workerId: "claimed", parentId: "lead", role: "implement", launchId: "wrong-token" });
  const launchClaim = claimLaunch(state, { launchId: "launch-token", workerId: "claimed", previousGeneration: null,
    piSessionPath: claimed.sessionFile, model: { provider: "fixture", id: "no-network" }, callerId: "lead",
    callerGeneration: lead.generation, pid: lead.pid, pidBirth: lead.pidBirth });
  process.env.DS_HERDR_LAUNCH_ID = "wrong-token";
  await assert.rejects(claimed.start(), /launch claim/, "child refuses an unrelated launch token");
  assert.ok(existsSync(join(launchClaim.path, "claim.json")), "child never releases caller's claim");
  const matchingClaimed = fixture({ workerId: "claimed", parentId: "lead", role: "implement", launchId: "launch-token" });
  process.env.DS_HERDR_LAUNCH_ID = "launch-token";
  const claimedIdentity = await matchingClaimed.start();
  assert.equal((await selfRequest(claimedIdentity, { kind: "status" })).identity.model.id, "no-network");
  launchClaim.release();
  assert.equal(existsSync(launchClaim.path), false, "launcher can release exact claim after matching live identity");
  await matchingClaimed.stop();
  const reloadedClaimed = fixture({ workerId: "claimed", parentId: "lead", role: "implement", launchId: "launch-token" });
  const reloadedIdentity = await reloadedClaimed.start("reload");
  assert.equal(reloadedIdentity.piSessionId, claimedIdentity.piSessionId, "worker reload keeps assigned conversation");
  assert.notEqual(reloadedIdentity.generation, claimedIdentity.generation);
  assert.equal(reloadedClaimed.sends, 0, "reload never replays submissions");
  await reloadedClaimed.stop();

  const pendingWorker = fixture({ workerId: "pending", parentId: "lead", role: "implement", mode: "pending" });
  const pending = await pendingWorker.start();
  const ambiguous = await selfRequest(pending, { kind: "submit", submissionId: "ambiguous", task: "never replay" });
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal((await selfRequest(pending, { kind: "status" })).active.phase, "ambiguous");
  const reset = await selfRequest(pending, { kind: "interrupt", submissionId: "ambiguous", timeoutMs: 10 });
  assert.equal(reset.kind, "reset_requested");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(pendingWorker.shutdowns, 1);
  assert.equal(JSON.parse(readFileSync(join(state, "tasks", "pending", "ambiguous.json"))).kind, "unavailable");
  assert.equal(pendingWorker.sends, 1);
  await pendingWorker.stop();

  const fault = fixture({ workerId: "fault", parentId: "lead", role: "explore", launchFault: "abort-after-create" });
  await fault.start();
  const controller = new AbortController();
  fault.setAbort(controller);
  await assert.rejects(fault.tools.get("spawn_agent").execute("spawn", { role: "implement", task: "complete brief" }, controller.signal, undefined, fault.ctx), /exact newly-created pane closed/);
  assert.ok(fault.commands.some(args => args[2] === "tab" && args[3] === "create" && args.includes("--workspace") && args.includes("w1")));
  assert.ok(fault.commands.some(args => args[2] === "pane" && args[3] === "close" && args[4] === "w1:new"));
  assert.ok(!fault.commands.some(args => args.includes("split")));
  const cancelledLaunch = fault.commands.find(args => args[2] === "tab" && args[3] === "create");
  const cancelledWorker = cancelledLaunch.find(value => value.startsWith("DS_HERDR_WORKER_ID=")).split("=")[1];
  assert.equal(existsSync(join(state, "locks", `launch-${cancelledWorker}`)), false, "proven pre-start cleanup releases launch claim");
  await fault.stop();

  const startupFault = fixture({ workerId: "startup-fault", parentId: "lead", role: "judgment" });
  await startupFault.start();
  assert.equal(startupFault.effort, "high");
  await assert.rejects(startupFault.tools.get("spawn_agent").execute("spawn-fail", { role: "implement", task: "complete brief" }, undefined, undefined, startupFault.ctx), /fixture startup failure.*exact newly-created pane closed/);
  assert.ok(startupFault.commands.some(args => args[2] === "pane" && args[3] === "close" && args[4] === "w1:new"));
  await startupFault.stop();

  const lost = fixture({ workerId: "lost-receipt", parentId: "lead", role: "review", launchFault: "unknown-create" });
  await lost.start();
  await assert.rejects(lost.tools.get("spawn_agent").execute("spawn-lost", { role: "implement", task: "complete brief" }, undefined, undefined, lost.ctx), /uncertain: no exact created pane receipt.*Durable receipt/);
  assert.ok(!lost.commands.some(args => args[2] === "pane" && args[3] === "close"), "uncertain creation never sweeps panes");
  await lost.stop();

  const duplicate = fixture({ workerId: "lead", restart: lead.generation });
  await assert.rejects(duplicate.start(), /still live/);
  assert.equal(JSON.parse(readFileSync(join(state, "workers", "lead.json"))).generation, lead.generation);
  verifySession(lead);
  assert.throws(() => verifySession({ ...lead, piSessionId: "wrong" }), /UUID mismatch/);
  await root.stop();

  processProbe = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(processProbe.pid);
  const probeBirth = processIdentity(processProbe.pid);
  assert.ok(probeBirth);
  const exited = once(processProbe, "exit");
  processProbe.kill("SIGTERM");
  await exited;
  const previous = { ...lead, pid: processProbe.pid, pidBirth: probeBirth.birth, available: false };
  assert.equal(isOriginalProcessLive(previous), false, "real child PID/birth death proof");
  atomicWrite(join(state, "workers", "lead.json"), previous);
  const oldTask = { kind: "active", phase: "started", nonce: "nonce", workerId: "lead", generation: previous.generation,
    piSessionId: previous.piSessionId, submissionId: "interrupted-old", task: "old task", startedAt: new Date().toISOString() };
  atomicWrite(join(state, "tasks", "lead", "interrupted-old.json"), oldTask);
  const revived = fixture({ restart: previous.generation });
  const newLead = await revived.start();
  assert.equal(newLead.piSessionId, previous.piSessionId);
  assert.notEqual(newLead.generation, previous.generation);
  assert.equal((await selfRequest(newLead, { kind: "wait", submissionId: "interrupted-old", timeoutMs: 10 })).kind, "unavailable");
  const oldRejected = await selfRequest(newLead, { kind: "wait", submissionId: "noauth", timeoutMs: 10 });
  assert.equal(oldRejected.generation, previous.generation, "old results keep original generation");
  assert.equal(revived.widgets.get("ds-plan")[0], "[ ]   exact step  ");
  await selfRequest(newLead, { kind: "submit", submissionId: "new", task: "only new task" });
  const oldAgain = await selfRequest(newLead, { kind: "wait", submissionId: "noauth", timeoutMs: 10 });
  assert.equal(oldAgain.generation, previous.generation);
  assert.equal((await selfRequest(newLead, { kind: "status" })).active.submissionId, "new", "historical wait does not mask or settle current task");
  assert.equal(revived.sends, 1);
  await revived.settle();
  await revived.stop();
  process.stdout.write("PASS adapter contracts with explicitly stubbed Pi/Herdr events; real UDS/files/proc. No native lifecycle or topology claim.\n");
} finally {
  if (processProbe && processProbe.exitCode === null && processProbe.signalCode === null) processProbe.kill("SIGKILL");
  for (const fixture of fixtures.reverse()) { try { await fixture.stop(); } catch {} }
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(socketDirectory(state, originalEnv.XDG_RUNTIME_DIR || "/tmp"), { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
