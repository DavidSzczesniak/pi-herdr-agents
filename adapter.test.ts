import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import adapter from "./index.ts";
import { atomicWrite, request } from "./protocol.ts";
import { socketDirectory } from "./startup.ts";
import { fakeApi, fakeContext, fakeModel, fakeModelRegistry, fakeSessions, fakeUi, hookRegistry, toolRegistry, present, toolText, installFixtureEnvironment, fakePane as pane, herdrArgs, herdrResult, execOk, execFailure, beforeAgentStart, completedSettle, replaceEnvironment } from "./fakes.ts";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { Request, Result } from "./protocol.ts";
import { Type } from "typebox";
import type { ChildProcess } from "node:child_process";
import { claimLaunch, isOriginalProcessLive, processIdentity, planLines, tabPane, takeClaim, verifySession, waitProgress, recordSubmittedSize, runningTools } from "./runtime.ts";
import { test } from "vitest";
import { ownChild } from "./test-support/process.ts";
import { finishCleanup } from "./test-support/cleanup.ts";

type OwnRequest = Request extends infer R ? R extends Request ? Omit<R, "callerId" | "callerGeneration" | "generation"> : never : never;
const selfRequest = (identity: { socketPath: string; workerId: string; generation: string }, operation: OwnRequest) => request(identity.socketPath, { callerId: identity.workerId, callerGeneration: identity.generation, generation: identity.generation, ...operation });
const status = async (identity: { socketPath: string; workerId: string; generation: string }): Promise<Extract<Result, { kind: "status" }>> => {
  const result = await selfRequest(identity, { kind: "status" });
  if (result.kind !== "status") throw new Error(`expected status, got ${result.kind}`);
  return result;
};

function adapterFixture() {
  const directory = mkdtempSync("/tmp/pha-");
  const state = directory;
  const originalEnv = { ...process.env };
  const fixtures: { stop(): Promise<void> }[] = [];
  const extraPanes: ReturnType<typeof pane>[] = [];
  let panePids: number[] = [];
  let closeKills = false;
  const header = { type: "session", version: 3, id: "session-lead", timestamp: new Date().toISOString(), cwd: directory };

  function fixture(options: { workerId?: string; role?: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; parentId?: string; auth?: boolean; mode?: string; restart?: string; sessionId?: string; failReport?: boolean; launchFault?: string; launchId?: string } = {}) {
    const { workerId = "lead", role = "lead", thinking = "high", parentId = "", auth = true, mode = "started", restart = "", sessionId = `session-${workerId}`, failReport = false, launchFault = "", launchId = "" } = options;
    installFixtureEnvironment({ XDG_RUNTIME_DIR: directory, DS_HERDR_STATE_DIR: state, DS_HERDR_SESSION: "slice", DS_HERDR_WORKSPACE: directory,
      DS_HERDR_WORKER_ID: workerId, DS_HERDR_ROLE: role, DS_HERDR_PARENT_ID: parentId, DS_HERDR_RESTART_GENERATION: restart, DS_HERDR_LAUNCH_ID: launchId,
      HERDR_ENV: "1", HERDR_SESSION: "slice", HERDR_SOCKET_PATH: "/fixture/herdr.sock", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: `w1:p-${workerId}` });
    const hooks = hookRegistry();
    const tools = toolRegistry();
    const commands: string[][] = [];
    const widgets = new Map<string, unknown>();
    let selectedTools = ["read", "bash", "external_evidence"];
    let startupError: string | undefined;
    let effort = thinking;
    let idle = true;
    let shutdowns = 0;
    let sends = 0;
    let runSignal: AbortSignal | undefined;
    let spawned: ReturnType<typeof pane> | undefined;
    let launched: Record<string, string> | undefined;
    let abortController: AbortController | undefined;
    const sessionFile = join(state, `${workerId}.jsonl`);
    if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ ...header, id: sessionId }) + "\n");
    const ctx = fakeContext({
      cwd: directory, mode: "tui", hasUI: true, get signal() { return runSignal; },
      model: fakeModel("fixture", "no-network"),
      modelRegistry: fakeModelRegistry({ auth }),
      sessionManager: fakeSessions({ getSessionFile: () => sessionFile, getSessionId: () => sessionId }),
      isIdle: () => idle, hasPendingMessages: () => false,
      abort: () => abortController?.abort(), shutdown: () => { shutdowns++; },
      ui: fakeUi({ notify(message) { startupError = message; }, setWidget(key, lines) { widgets.set(key, lines); } }),
    });
    const emit = async (event: ExtensionEvent) => { await hooks.emit(event, ctx); };
    const api = fakeApi({
      on: hooks.on, registerTool: tools.register,
      registerCommand() {},
      getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls", "external_evidence", ...tools.keys()].map(name => ({ name, description: "fixture", parameters: Type.Object({}), sourceInfo: { path: "fixture", source: "fixture", scope: "temporary", origin: "top-level" } })),
      getActiveTools: () => selectedTools, setActiveTools: names => { selectedTools = names; },
      getThinkingLevel: () => effort, setThinkingLevel: level => { effort = level; },
      appendEntry(type, data) { writeFileSync(sessionFile, JSON.stringify({ type: "custom", customType: type, data }) + "\n", { flag: "a" }); },
      async exec(_command, args, options) {
        assert.equal(_command, "env");
        assert.ok(args.includes("HERDR_SOCKET_PATH=/fixture/herdr.sock"));
        const op = herdrArgs(args);
        commands.push(["--session", "slice", ...op]);
        if (op[0] === "tab" && op[1] === "create") {
          spawned = pane("w1:new");
          launched = Object.fromEntries(op.filter(value => /^DS_HERDR_(LAUNCH|WORKER)_ID=/.test(value)).map(value => value.split("=")));
          if (launchFault === "unknown-create") return execFailure("fixture receipt lost", { killed: true });
          if (launchFault === "abort-after-create") present(abortController, "launch abort controller").abort();
          return herdrResult({ root_pane: spawned });
        }
        if (op[0] === "pane" && op[1] === "process-info")
          return herdrResult({ process_info: { pane_id: op[3], shell_pid: panePids[0] ?? null,
            foreground_process_group_id: panePids[0] ?? null, foreground_processes: panePids.map(pid => ({ pid, name: "pi" })) } });
        if (op[0] === "agent" && op[1] === "start" && launchFault.startsWith("child-exits")) {
          atomicWrite(join(state, "operations", `startup-failed-${present(launched, "launched environment").DS_HERDR_LAUNCH_ID}.json`), { launchId: present(launched, "launched environment").DS_HERDR_LAUNCH_ID,
            workerId: present(launched, "launched environment").DS_HERDR_WORKER_ID, error: "fixture cwd mismatch", pid: process.pid,
            pidBirth: launchFault === "child-exits-live" ? present(processIdentity(process.pid), "process identity").birth : "exited-child" });
          return new Promise(resolve => present(options?.signal, "exec signal").addEventListener("abort", () => resolve(execFailure("", { killed: true }))));
        }
        if (op[0] === "agent" && op[1] === "start") return execFailure("fixture startup failure");
        if (op[0] === "pane" && op[1] === "list") return herdrResult({ panes: [...["w1:cowned", "w1:cstranger", "w1:cwaiting"].map(id => pane(id)), ...extraPanes] });
        if (op[0] === "pane" && op[1] === "get") return herdrResult({ pane: op[2] === "w1:new" ? spawned : pane(op[2]) });
        if (op[0] === "pane" && op[1] === "close" && closeKills) for (const pid of panePids) process.kill(pid, "SIGHUP");
        if (failReport && op[1] === "release-agent") throw new Error("fixture report failure");
        return execOk();
      },
      sendUserMessage(text) {
        if (typeof text !== "string") throw new Error("expected user text");
        sends++;
        void (async () => {
          await emit({ type: "input", source: "extension", text });
          if (mode !== "started") return;
          await emit(beforeAgentStart({ cwd: directory, prompt: text }));
          idle = false;
          abortController = new AbortController();
          runSignal = abortController.signal;
          await emit({ type: "agent_start" });
        })();
      },
    });
    adapter(api);
    const instance = {
      tools, commands, widgets, ctx, emit, sessionFile,
      get sends() { return sends; }, get shutdowns() { return shutdowns; }, get effort() { return effort; }, get activeTools() { return selectedTools; },
      setAbort(controller: AbortController) { abortController = controller; },
      async start(reason: "startup" | "reload" = "startup") { await emit({ type: "session_start", reason }); if (startupError) throw new Error(startupError); return JSON.parse(readFileSync(join(state, "workers", `${workerId}.json`), "utf8")); },
      async settle() { await emit(completedSettle()); idle = true; await emit({ type: "agent_settled" }); },
      async stop() { await emit({ type: "session_shutdown", reason: "quit" }); },
    };
    fixtures.push(instance);
    return instance;
  }

  const probes = new Map<ChildProcess, ReturnType<typeof ownChild>>();
  function ownProbe<T extends ChildProcess>(child: T): T { probes.set(child, ownChild(child)); return child; }
  const exitOf = (child: ChildProcess) => present(probes.get(child), "owned probe").exited;
  const stopProbe = (child: ChildProcess) => present(probes.get(child), "owned probe").stop();
  return { directory, state, fixture, extraPanes, ownProbe, exitOf, stopProbe,
    controls: { set panePids(value: number[]) { panePids = value; }, set closeKills(value: boolean) { closeKills = value; } },
    async close() {
      await finishCleanup([], [
        ...fixtures.reverse().map(fixture => () => fixture.stop()),
        ...[...probes.values()].map(probe => () => probe.stop()),
        () => replaceEnvironment(originalEnv),
        () => rmSync(socketDirectory(state, directory), { recursive: true, force: true }),
        () => rmSync(directory, { recursive: true, force: true }),
      ]);
    },
  };
}
async function withAdapter(check: (suite: ReturnType<typeof adapterFixture>) => Promise<void>) {
  const suite = adapterFixture();
  const errors: unknown[] = [];
  try { await check(suite); } catch (error) { errors.push(error); }
  finally { await finishCleanup(errors, [() => suite.close()]); }
}

test("distinguishes PID birth and validates pane workspace and verbatim plans", () => {
  const current = processIdentity(process.pid);
  assert.ok(current);
  assert.equal(isOriginalProcessLive({ pid: process.pid, pidBirth: current.birth }), true);
  assert.equal(isOriginalProcessLive({ pid: process.pid, pidBirth: "different-birth" }), false);
  assert.throws(() => tabPane({ result: { root_pane: pane() } }, "other"), /workspace/);
  assert.deepEqual(tabPane({ result: { root_pane: pane() } }, "w1"), pane());
  assert.equal(planLines({ plan: [{ step: "  Verbatim\nstep.  ", status: "in_progress" }] })[0], "[>]   Verbatim\nstep.  ");
});

test("missing auth refuses submission without sending and fences duplicate IDs", { timeout: 30_000 }, () => withAdapter(async ({ fixture }) => {
  const root = fixture({ auth: false });
  const lead = await root.start();
  assert.equal(root.effort, "high", "lead launcher thinking preserved");
  assert.ok(root.activeTools.includes("external_evidence"));
  const noauth = await selfRequest(lead, { kind: "submit", submissionId: "noauth", task: "not executed" });
  assert.equal(noauth.kind, "unavailable");
  assert.equal(root.sends, 0);
  assert.equal((await status(lead)).active, null);
  await assert.rejects(selfRequest(lead, { kind: "submit", submissionId: "noauth", task: "duplicate" }), /Duplicate/);
}));

test("review worker preserves lead selection and plan and settles correlated work", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture({ auth: false });
  const lead = await root.start();
  assert.equal(root.effort, "high", "lead launcher thinking preserved");
  assert.ok(root.activeTools.includes("external_evidence"));
  await root.tools.get("update_plan").execute("p1", { plan: [{ step: "  exact step  ", status: "pending" }] }, undefined, undefined, root.ctx);
  const leadPlan = readFileSync(join(state, "plans", "lead.json"), "utf8");
  assert.equal(JSON.parse(leadPlan).plan[0].step, "  exact step  ");

  const reviewer = fixture({ workerId: "reviewer", role: "review", thinking: "medium", parentId: "lead", failReport: true });
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
}));

test("native model selection survives cold continuation and uncertainty fences retry", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const modelOwner = fixture({ workerId: "model-owner", role: "implement", parentId: "lead" });
  const originalModelOwner = await modelOwner.start();
  assert.deepEqual(originalModelOwner.model, { provider: "fixture", id: "no-network" });
  const selectedModel = { provider: "another-provider", id: "human-selected-model" };
  const nativeModel = fakeModel(selectedModel.provider, selectedModel.id);
  modelOwner.ctx.model = nativeModel;
  await modelOwner.emit({ type: "model_select", model: nativeModel, previousModel: fakeModel("fixture", "no-network"), source: "set" });
  await modelOwner.stop();
  const deadModelOwner = JSON.parse(readFileSync(join(state, "workers", "model-owner.json"), "utf8"));
  assert.deepEqual(deadModelOwner.model, selectedModel, "native model_select persists current authoritative model");
  assert.ok(!readFileSync(modelOwner.sessionFile, "utf8").includes('"type":"message"'), "preflight-only session has no messages");
  atomicWrite(join(state, "workers", "model-owner.json"), { ...deadModelOwner, pidBirth: "dead-previous-process" });
  await assert.rejects(root.tools.get("followup_task").execute("model-revive", { agent_id: "model-owner", task: "new task only" }, undefined, undefined, root.ctx), /fixture startup failure/);
  const modelStart = present(root.commands.find(args => args[2] === "agent" && args[3] === "start"), "model start command");
  assert.equal(modelStart[modelStart.indexOf("--model") + 1], "another-provider/human-selected-model");
  assert.ok(existsSync(join(state, "locks", "launch-model-owner", "claim.json")), "unconfirmed native process retains launch fence");
  const startsBeforeRetry = root.commands.length;
  await assert.rejects(root.tools.get("followup_task").execute("model-retry", { agent_id: "model-owner", task: "retry forbidden" }, undefined, undefined, root.ctx), /EEXIST/);
  assert.equal(root.commands.length, startsBeforeRetry, "unresolved fence blocks retry before Herdr or session open");
  const wrongModel = fixture({ workerId: "model-owner", role: "implement", parentId: "lead", restart: deadModelOwner.generation });
  await assert.rejects(wrongModel.start(), /original Pi session required/, "startup refuses model fallback instead of silently changing it");
}));

test("wrong launch token records failure and matching claim permits same-process reload", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  const lead = await root.start();
  const claimed = fixture({ workerId: "claimed", parentId: "lead", role: "implement", launchId: "wrong-token" });
  const launchClaim = claimLaunch(state, { launchId: "launch-token", workerId: "claimed", previousGeneration: null,
    piSessionPath: claimed.sessionFile, model: { provider: "fixture", id: "no-network" }, thinking: "medium", callerId: "lead",
    callerGeneration: lead.generation, pid: lead.pid, pidBirth: lead.pidBirth });
  process.env.DS_HERDR_LAUNCH_ID = "wrong-token";
  await assert.rejects(claimed.start(), /launch claim/, "child refuses an unrelated launch token");
  const recorded = JSON.parse(readFileSync(join(state, "operations", "startup-failed-wrong-token.json"), "utf8"));
  assert.match(recorded.error, /launch claim/, "a failed child records why for its launcher");
  assert.deepEqual([recorded.workerId, recorded.pid], ["claimed", process.pid]);
  assert.ok(existsSync(join(launchClaim.path, "claim.json")), "child never releases caller's claim");
  const matchingClaimed = fixture({ workerId: "claimed", parentId: "lead", role: "implement", thinking: "medium", launchId: "launch-token" });
  process.env.DS_HERDR_LAUNCH_ID = "launch-token";
  const claimedIdentity = await matchingClaimed.start();
  assert.equal(present((await status(claimedIdentity)).identity.model, "claimed model").id, "no-network");
  launchClaim.release();
  assert.equal(existsSync(launchClaim.path), false, "launcher can release exact claim after matching live identity");
  await matchingClaimed.stop();
  const reloadedClaimed = fixture({ workerId: "claimed", parentId: "lead", role: "implement", thinking: "medium", launchId: "launch-token" });
  const reloadedIdentity = await reloadedClaimed.start("reload");
  assert.equal(reloadedIdentity.piSessionId, claimedIdentity.piSessionId, "worker reload keeps assigned conversation");
  assert.notEqual(reloadedIdentity.generation, claimedIdentity.generation);
  assert.equal(reloadedClaimed.sends, 0, "reload never replays submissions");
  await reloadedClaimed.stop();
}));

test("ambiguous preflight interrupt requests shutdown and records unavailable once", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const pendingWorker = fixture({ workerId: "pending", parentId: "lead", role: "implement", mode: "pending" });
  const pending = await pendingWorker.start();
  const ambiguous = await selfRequest(pending, { kind: "submit", submissionId: "ambiguous", task: "never replay" });
  assert.equal(ambiguous.kind, "ambiguous");
  const pendingActive = present((await status(pending)).active, "pending task");
  if (pendingActive.kind !== "active") throw new Error("expected active pending task");
  assert.equal(pendingActive.phase, "ambiguous");
  const reset = await selfRequest(pending, { kind: "interrupt", submissionId: "ambiguous", timeoutMs: 10 });
  assert.equal(reset.kind, "reset_requested");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(pendingWorker.shutdowns, 1);
  assert.equal(JSON.parse(readFileSync(join(state, "tasks", "pending", "ambiguous.json"), "utf8")).kind, "unavailable");
  assert.equal(pendingWorker.sends, 1);
  await pendingWorker.stop();
}));

test("cancel after creation closes only the new pane and releases prestart claim", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const fault = fixture({ workerId: "fault", parentId: "lead", role: "explore", launchFault: "abort-after-create" });
  await fault.start();
  const controller = new AbortController();
  fault.setAbort(controller);
  await assert.rejects(fault.tools.get("spawn_agent").execute("spawn", { role: "implement", thinking: "medium", task: "complete brief" }, controller.signal, undefined, fault.ctx), /exact newly-created pane closed/);
  assert.ok(fault.commands.some(args => args[2] === "tab" && args[3] === "create" && args.includes("--workspace") && args.includes("w1")));
  assert.ok(fault.commands.some(args => args[2] === "pane" && args[3] === "close" && args[4] === "w1:new"));
  assert.ok(!fault.commands.some(args => args.includes("split")));
  const cancelledLaunch = present(fault.commands.find(args => args[2] === "tab" && args[3] === "create"), "cancelled tab command");
  const cancelledWorker = present(cancelledLaunch.find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "cancelled worker environment").split("=")[1];
  assert.equal(existsSync(join(state, "locks", `launch-${cancelledWorker}`)), false, "proven pre-start cleanup releases launch claim");
  await fault.stop();
}));

test("unexplained startup failure needs process proof before never-started retirement", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state, extraPanes }) => {
  const root = fixture();
  await root.start();
  const startupFault = fixture({ workerId: "startup-fault", parentId: "lead", role: "judgment" });
  await startupFault.start();
  assert.equal(startupFault.effort, "high");
  await assert.rejects(startupFault.tools.get("spawn_agent").execute("spawn-fail", { role: "implement", thinking: "medium", task: "complete brief" }, undefined, undefined, startupFault.ctx), /fixture startup failure.*exact newly-created pane closed/);
  assert.ok(startupFault.commands.some(args => args[2] === "pane" && args[3] === "close" && args[4] === "w1:new"));
  const unstarted = present(present(startupFault.commands.find(args => args[2] === "tab" && args[3] === "create"), "tab command").find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "worker environment").split("=")[1];
  assert.ok(existsSync(join(state, "locks", `launch-${unstarted}`)), "an unexplained startup failure keeps its claim");
  const retireUnstarted = () => startupFault.tools.get("retire_agent").execute("retire", { agent_id: unstarted }, undefined, undefined, startupFault.ctx);
  await assert.rejects(retireUnstarted(), /No recorded process/, "pane absence alone is not process proof");
  await assert.rejects(root.tools.get("retire_agent").execute("retire", { agent_id: "never-launched" }, undefined, undefined, root.ctx), /No worker identity or launch claim/);
  atomicWrite(join(state, "operations", `launch-${JSON.parse(readFileSync(join(state, "locks", `launch-${unstarted}`, "claim.json"), "utf8")).launchId}.json`),
    { ...JSON.parse(readFileSync(join(state, "operations", `launch-${JSON.parse(readFileSync(join(state, "locks", `launch-${unstarted}`, "claim.json"), "utf8")).launchId}.json`), "utf8")),
      data: { kind: "failed", processes: [{ pid: process.pid, pidBirth: "exited-shell" }] } });
  extraPanes.push(pane("w1:new"));
  await assert.rejects(retireUnstarted(), /still open/, "a never-started child retires only once its pane is gone");
  extraPanes.length = 0;
  const unstartedResult = JSON.parse(toolText(await retireUnstarted()));
  assert.equal(unstartedResult.state, "retired");
  assert.equal(existsSync(join(state, "locks", `launch-${unstarted}`)), false, "retiring a never-started child releases its claim");
  assert.ok(existsSync(unstartedResult.evidencePath));
  assert.equal(JSON.parse(toolText(await retireUnstarted())).evidencePath, unstartedResult.evidencePath, "a repeat returns the recorded retirement");
  await startupFault.stop();
}));

test("live pane process blocks retirement until death and exact pane absence", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state, controls, extraPanes, ownProbe, exitOf }) => {
  const root = fixture();
  await root.start();
  const startupFault = fixture({ workerId: "startup-fault", parentId: "lead", role: "judgment" });
  await startupFault.start();
  const paneProbe = ownProbe(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  controls.panePids = [present(paneProbe.pid, "pane process pid")];
  await assert.rejects(startupFault.tools.get("spawn_agent").execute("spawn-slow", { role: "implement", thinking: "medium", task: "complete brief" }, undefined, undefined, startupFault.ctx),
    /launch claim retained/);
  controls.panePids = [];
  const slow = present(present(startupFault.commands.filter(args => args[2] === "tab" && args[3] === "create").at(-1), "tab command").find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "worker environment").split("=")[1];
  const retireSlow = () => startupFault.tools.get("retire_agent").execute("retire", { agent_id: slow }, undefined, undefined, startupFault.ctx);
  await assert.rejects(retireSlow(), /still live/, "a live recorded process blocks retirement");
  const probeExit = exitOf(paneProbe);
  paneProbe.kill("SIGTERM");
  await probeExit;
  extraPanes.push({ ...pane("w1:other"), terminal_id: "term-w1:new" });
  await assert.rejects(retireSlow(), /ambiguous/, "a partial pane match is not ours to close");
  extraPanes.length = 0;
  assert.equal(JSON.parse(toolText(await retireSlow())).state, "retired", "a recorded process proven dead releases the claim");
  assert.ok(!existsSync(join(state, "locks", `launch-${slow}`)));
}));

test("pane-close process snapshot proves cleanup without child-failure record", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state, controls, ownProbe }) => {
  const root = fixture();
  await root.start();
  const startupFault = fixture({ workerId: "startup-fault", parentId: "lead", role: "judgment" });
  await startupFault.start();
  const hungUp = ownProbe(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  controls.panePids = [present(hungUp.pid, "hung-up process pid")];
  controls.closeKills = true;
  await assert.rejects(startupFault.tools.get("spawn_agent").execute("spawn-hup", { role: "implement", thinking: "medium", task: "complete brief" }, undefined, undefined, startupFault.ctx),
    /process cleanup proven/);
  controls.panePids = [];
  controls.closeKills = false;
  const hup = present(present(startupFault.commands.filter(args => args[2] === "tab" && args[3] === "create").at(-1), "tab command").find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "worker environment").split("=")[1];
  assert.ok(!existsSync(join(state, "locks", `launch-${hup}`)), "a snapshot proven dead releases the claim without a failure record");
}));

test("launch release tolerates retired claim but rejects missing foreign fence", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const raced = claimLaunch(state, { launchId: "raced-launch", workerId: "raced", previousGeneration: null,
    piSessionPath: join(state, "raced.jsonl"), model: { provider: "fixture", id: "no-network" }, thinking: "medium", callerId: "startup-fault",
    callerGeneration: "g", pid: process.pid, pidBirth: present(processIdentity(process.pid), "process identity").birth });
  const racedTaken = takeClaim(state, "raced", "raced-launch", "retired");
  assert.ok(racedTaken);
  raced.release();
  rmSync(racedTaken, { recursive: true });
  const lostFence = claimLaunch(state, { launchId: "lost-launch", workerId: "lost-fence", previousGeneration: null,
    piSessionPath: join(state, "lost.jsonl"), model: { provider: "fixture", id: "no-network" }, thinking: "medium", callerId: "startup-fault",
    callerGeneration: "g", pid: process.pid, pidBirth: present(processIdentity(process.pid), "process identity").birth });
  rmSync(lostFence.path, { recursive: true });
  assert.throws(() => lostFence.release(), /fence was removed/);
}));

test("interrupted fresh-launch retirement finishes on retry with recorded evidence", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const startupFault = fixture({ workerId: "startup-fault", parentId: "lead", role: "judgment" });
  await startupFault.start();
  const interrupted = claimLaunch(state, { launchId: "interrupted-launch", workerId: "interrupted", previousGeneration: null,
    piSessionPath: join(state, "interrupted.jsonl"), model: { provider: "fixture", id: "no-network" }, thinking: "medium", callerId: "startup-fault",
    callerGeneration: "g", pid: process.pid, pidBirth: present(processIdentity(process.pid), "process identity").birth });
  assert.ok(takeClaim(state, "interrupted", "interrupted-launch", "retired"));
  const finished = JSON.parse(toolText(await startupFault.tools.get("retire_agent").execute("retire", { agent_id: "interrupted" }, undefined, undefined, startupFault.ctx)));
  assert.match(finished.reason, /interrupted retirement/);
  assert.ok(!existsSync(join(state, "locks", "retired-launch-interrupted-interrupted-launch")));
  assert.equal(JSON.parse(toolText(await startupFault.tools.get("retire_agent").execute("retire", { agent_id: "interrupted" }, undefined, undefined, startupFault.ctx))).evidencePath,
    finished.evidencePath, "a repeat returns the recorded retirement");
  void interrupted;
}));

test("unfinished or unowned launch cannot be retired", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const startupFault = fixture({ workerId: "startup-fault", parentId: "lead", role: "judgment" });
  await startupFault.start();
  const crafted = claimLaunch(state, { launchId: "crafted-launch", workerId: "crafted", previousGeneration: null,
    piSessionPath: join(state, "crafted.jsonl"), model: { provider: "fixture", id: "no-network" }, thinking: "medium", callerId: "startup-fault",
    callerGeneration: "g", pid: process.pid, pidBirth: present(processIdentity(process.pid), "process identity").birth });
  atomicWrite(join(state, "operations", "launch-crafted-launch.json"), { launchId: "crafted-launch", workerId: "crafted", pane: pane("w1:crafted"),
    data: { kind: "starting" } });
  await assert.rejects(startupFault.tools.get("retire_agent").execute("retire", { agent_id: "crafted" }, undefined, undefined, startupFault.ctx), /Launch not finished/);
  const outsider = fixture({ workerId: "outsider", parentId: "lead", role: "explore" });
  await outsider.start();
  await assert.rejects(outsider.tools.get("retire_agent").execute("retire", { agent_id: "crafted" }, undefined, undefined, outsider.ctx), /not this caller's descendant/);
  await outsider.stop();
  crafted.release();
}));

test("failure record naming live process retains launch claim", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const liveExit = fixture({ workerId: "live-exit", parentId: "lead", role: "judgment", launchFault: "child-exits-live" });
  await liveExit.start();
  await assert.rejects(liveExit.tools.get("spawn_agent").execute("spawn-live", { role: "implement", thinking: "medium", task: "complete brief" }, undefined, undefined, liveExit.ctx),
    /Worker startup failed: fixture cwd mismatch.*launch claim retained/);
  const liveChild = present(present(liveExit.commands.find(args => args[2] === "tab" && args[3] === "create"), "tab command").find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "worker environment").split("=")[1];
  assert.ok(existsSync(join(state, "locks", `launch-${liveChild}`)), "a failure record naming a live process keeps the claim");
  rmSync(join(state, "locks", `launch-${liveChild}`), { recursive: true });
  await liveExit.stop();
}));

test("dead child failure record ends readiness wait before five seconds", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  await root.start();
  const childExit = fixture({ workerId: "exited-child", parentId: "lead", role: "judgment", launchFault: "child-exits" });
  await childExit.start();
  const began = Date.now();
  await assert.rejects(childExit.tools.get("spawn_agent").execute("spawn-exit", { role: "implement", thinking: "medium", task: "complete brief" }, undefined, undefined, childExit.ctx),
    /Worker startup failed: fixture cwd mismatch.*process cleanup proven/);
  assert.ok(Date.now() - began < 5000, "the child's failure record ends the readiness wait");
  const exitedChild = present(present(childExit.commands.find(args => args[2] === "tab" && args[3] === "create"), "tab command").find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "worker environment").split("=")[1];
  assert.equal(existsSync(join(state, "locks", `launch-${exitedChild}`)), false, "a recorded and proven-dead child releases its claim");
  await childExit.stop();
}));

test("unknown tab creation outcome never sweeps panes", { timeout: 30_000 }, () => withAdapter(async ({ fixture }) => {
  const root = fixture();
  await root.start();
  const lost = fixture({ workerId: "lost-receipt", parentId: "lead", role: "review", launchFault: "unknown-create" });
  await lost.start();
  await assert.rejects(lost.tools.get("spawn_agent").execute("spawn-lost", { role: "implement", thinking: "medium", task: "complete brief" }, undefined, undefined, lost.ctx), /uncertain: no exact created pane receipt.*Durable receipt/);
  assert.ok(!lost.commands.some(args => args[2] === "pane" && args[3] === "close"), "uncertain creation never sweeps panes");
  await lost.stop();
}));

test("live duplicate cannot replace generation and session UUID is verified", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state }) => {
  const root = fixture();
  const lead = await root.start();
  const duplicate = fixture({ workerId: "lead", restart: lead.generation });
  await assert.rejects(duplicate.start(), /still live/);
  assert.equal(JSON.parse(readFileSync(join(state, "workers", "lead.json"), "utf8")).generation, lead.generation);
  verifySession(lead);
  assert.throws(() => verifySession({ ...lead, piSessionId: "wrong" }), /UUID mismatch/);
  await root.stop();
}));

test("real child death proves the saved PID is no longer live", { timeout: 30_000 }, () => withAdapter(async ({ fixture, ownProbe, exitOf }) => {
  const root = fixture();
  const lead = await root.start();
  const processProbe = ownProbe(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  assert.ok(processProbe.pid);
  const probeBirth = processIdentity(processProbe.pid);
  assert.ok(probeBirth);
  const exited = exitOf(processProbe);
  processProbe.kill("SIGTERM");
  await exited;
  const previous = { ...lead, pid: processProbe.pid, pidBirth: probeBirth.birth, available: false };
  assert.equal(isOriginalProcessLive(previous), false, "real child PID/birth death proof");
}));

test("a zombie is not a live original writer", { timeout: 30_000 }, () => withAdapter(async ({ ownProbe, stopProbe }) => {
  const holder = ownProbe(spawn("perl", ["-e", "$| = 1; my $p = fork // die; exit 0 unless $p; $SIG{TERM} = sub { waitpid($p, 0); exit 0 }; print \"$p\\n\"; sleep 30; waitpid($p, 0)"], { stdio: ["ignore", "pipe", "inherit"] }));
  const zombie = Number(String((await once(holder.stdout, "data"))[0]));
  for (let n = 0; n < 100 && processIdentity(zombie)?.state !== "Z"; n++) await new Promise(resolve => setTimeout(resolve, 20));
  const zombieIdentity = processIdentity(zombie);
  assert.equal(zombieIdentity?.state, "Z");
  assert.equal(isOriginalProcessLive({ pid: zombie, pidBirth: zombieIdentity.birth }), false, "zombie is not live");
  await stopProbe(holder);
}));

test("cold recovery keeps conversation and historical results without masking current work", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state, ownProbe, exitOf }) => {
  const root = fixture({ auth: false });
  const lead = await root.start();
  assert.equal(root.effort, "high", "lead launcher thinking preserved");
  assert.ok(root.activeTools.includes("external_evidence"));
  const noauth = await selfRequest(lead, { kind: "submit", submissionId: "noauth", task: "not executed" });
  assert.equal(noauth.kind, "unavailable");
  assert.equal(root.sends, 0);
  assert.equal((await status(lead)).active, null);
  await assert.rejects(selfRequest(lead, { kind: "submit", submissionId: "noauth", task: "duplicate" }), /Duplicate/);
  await root.tools.get("update_plan").execute("p1", { plan: [{ step: "  exact step  ", status: "pending" }] }, undefined, undefined, root.ctx);
  const leadPlan = readFileSync(join(state, "plans", "lead.json"), "utf8");
  assert.equal(JSON.parse(leadPlan).plan[0].step, "  exact step  ");
  await root.stop();

  const processProbe = ownProbe(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  assert.ok(processProbe.pid);
  const probeBirth = processIdentity(processProbe.pid);
  assert.ok(probeBirth);
  const exited = exitOf(processProbe);
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
  if (oldRejected.kind !== "unavailable") throw new Error(`expected unavailable, got ${oldRejected.kind}`);
  assert.equal(oldRejected.generation, previous.generation, "old results keep original generation");
  const revivedWidget = present(revived.widgets.get("ds-plan"), "plan widget");
  if (!Array.isArray(revivedWidget)) throw new Error("expected plan widget lines");
  assert.equal(revivedWidget[0], "[ ]   exact step  ");
  await selfRequest(newLead, { kind: "submit", submissionId: "new", task: "only new task" });
  const oldAgain = await selfRequest(newLead, { kind: "wait", submissionId: "noauth", timeoutMs: 10 });
  if (oldAgain.kind !== "unavailable") throw new Error(`expected unavailable, got ${oldAgain.kind}`);
  assert.equal(oldAgain.generation, previous.generation);
  assert.equal(present((await status(newLead)).active, "new task").submissionId, "new", "historical wait does not mask or settle current task");
  assert.equal(revived.sends, 1);
  await revived.settle();
}));

test("Claude tool routing enforces descendant ownership and one-shot follow-up", { timeout: 30_000 }, () => withAdapter(async ({ fixture, directory, state }) => {
  const revived = fixture();
  await revived.start();
  const plantClaude = (id: string, parentId: string, stop?: string) => {
    const dir = join(state, "claude", id);
    mkdirSync(join(dir, "hooks"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "hooks", "UserPromptSubmit-1-1.json"), JSON.stringify({ session_id: "cs", transcript_path: join(dir, "transcript.jsonl") }));
    writeFileSync(join(dir, "transcript.jsonl"), stop ? JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] }) + "\n" : "");
    if (stop) writeFileSync(join(dir, "hooks", "Stop-2-2.json"), JSON.stringify({ session_id: "cs", last_assistant_message: stop }));
    atomicWrite(join(dir, "worker.json"), { workerId: id, parentId, role: "review", runtime: "claude", model: "claude-opus-5-5", effort: "high",
      cwd: directory, workspaceId: "w1", tabId: `tab-w1:${id}`, paneId: `w1:${id}`, terminalId: `term-w1:${id}`, launchId: "claude-launch",
      state: "open", task: { submissionId: `sub-${id}`, kind: "active", outcome: null, finalText: "", artifactPath: null, reason: null,
        claudeSessionId: "cs", transcriptPath: "/tmp/claude.jsonl", startedAt: new Date().toISOString() } });
  };
  plantClaude("cowned", "lead", "planted review");
  plantClaude("cstranger", "stranger", "not yours");
  const tool = async (name: string, params: unknown) => JSON.parse(toolText(await revived.tools.get(name).execute(name, params, undefined, undefined, revived.ctx)));
  const claudeResult = await tool("wait_agent", { agent_id: "cowned", submission_id: "sub-cowned", timeout_ms: 120000 });
  assert.equal(claudeResult.sessionGrowth, undefined, "a settled wait carries no progress fields");
  assert.match(revived.tools.get("wait_agent").description, /Two consecutive timeouts with zero sessionGrowth and empty pending mean a stall/);
  assert.equal(claudeResult.runtime, "claude");
  assert.equal(claudeResult.outcome, "completed");
  assert.equal(claudeResult.finalText, "planted review");
  const listed: { kind: string; workerId: string }[] = await tool("list_agents", {});
  assert.ok(listed.some((row) => row.kind === "claude_status" && row.workerId === "cowned"));
  assert.ok(!listed.some((row) => row.workerId === "cstranger"), "another parent's Claude worker is not listed");
  await assert.rejects(tool("wait_agent", { agent_id: "cstranger", submission_id: "sub-cstranger", timeout_ms: 120000 }), /not this caller's descendant/);
  await assert.rejects(tool("followup_task", { agent_id: "cowned", task: "second" }), /one-shot/);
  assert.equal((await tool("interrupt_agent", { agent_id: "cowned", submission_id: "sub-cowned" })).outcome, "completed", "settled work is never re-labelled");
  await assert.rejects(tool("spawn_agent", { runtime: "claude", role: "review", thinking: "minimal", task: "x" }), /Invalid|Expected|must/i);
}));

test("timeout growth tracks caller-specific baselines and unknown files", { timeout: 30_000 }, () => withAdapter(async ({ state }) => {
  mkdirSync(join(state, "operations"));
  const transcript = join(state, "claude-progress.jsonl");
  writeFileSync(transcript, "a".repeat(10));
  assert.deepEqual(waitProgress(state, "lead", "cprogress", "sub-p", transcript), { sessionBytes: 10, sessionGrowth: null }, "no submission record leaves growth unknown");
  writeFileSync(transcript, "a".repeat(25));
  assert.deepEqual(waitProgress(state, "lead", "cprogress", "sub-p", transcript), { sessionBytes: 25, sessionGrowth: 15 });
  assert.deepEqual(waitProgress(state, "lead", "cprogress", "sub-p", transcript), { sessionBytes: 25, sessionGrowth: 0 }, "no growth is a stall window");
  assert.deepEqual(waitProgress(state, "owner", "cprogress", "sub-p", transcript), { sessionBytes: 25, sessionGrowth: null }, "each caller keeps its own baseline");
  assert.deepEqual(waitProgress(state, "lead", "cprogress", "sub-p", null), { sessionBytes: null, sessionGrowth: null }, "unknown transcript reports nulls");
  assert.deepEqual(waitProgress(state, "lead", "cdir", "sub-d", state), { sessionBytes: null, sessionGrowth: null }, "a directory is not a session file");
  assert.deepEqual(waitProgress(state, "lead", "cprogress", "sub-p", transcript), { sessionBytes: 25, sessionGrowth: null }, "growth needs two known sizes");
}));

test("first timeout measures from submission including later-created transcript", { timeout: 30_000 }, () => withAdapter(async ({ state }) => {
  mkdirSync(join(state, "operations"));
  const transcript = join(state, "progress.jsonl");
  writeFileSync(transcript, "x".repeat(40));
  recordSubmittedSize(state, "pfirst", "sub-f", transcript);
  writeFileSync(transcript, "x".repeat(55));
  assert.deepEqual(waitProgress(state, "lead", "pfirst", "sub-f", transcript), { sessionBytes: 55, sessionGrowth: 15 }, "first timeout measures from submission");
  const late = join(state, "late-transcript.jsonl");
  recordSubmittedSize(state, "clate", "sub-l", late);
  writeFileSync(late, "x".repeat(12));
  assert.deepEqual(waitProgress(state, "lead", "clate", "sub-l", late), { sessionBytes: 12, sessionGrowth: 12 }, "a transcript created after acceptance grows from zero");
  assert.deepEqual(waitProgress(state, "lead", "pfirst", "sub-f", transcript), { sessionBytes: 55, sessionGrowth: 0 }, "two timeouts judge a stall");
}));

test("running tools excludes ended calls, other generations, and malformed audit lines", { timeout: 30_000 }, () => withAdapter(async ({ state }) => {
  mkdirSync(join(state, "audit"));
  const auditLine = (generation: string, event: string, data: Record<string, unknown>) => JSON.stringify({ at: "2026-09-27T00:00:00.000Z", workerId: "piworker", generation, submissionId: null, event, data }) + "\n";
  writeFileSync(join(state, "audit", "piworker.ndjson"), auditLine("g1", "tool_start", { toolName: "bash", toolCallId: "t1" }) +
    auditLine("g1", "tool_end", { toolName: "bash", toolCallId: "t1", isError: false }) + auditLine("g1", "tool_start", { toolName: "bash", toolCallId: "t2" }) +
    auditLine("g0", "tool_start", { toolName: "read", toolCallId: "t0" }) + "not json\n");
  assert.deepEqual(runningTools(state, "piworker", "g1"), [{ kind: "tool", tool: "bash", id: "t2", startedAt: "2026-09-27T00:00:00.000Z" }]);
  assert.deepEqual(runningTools(state, "no-audit", "g1"), [], "no audit log means nothing is known to be running");
}));

test("shutdown cancels a Claude wait and prevents writes after detachment", { timeout: 30_000 }, () => withAdapter(async ({ fixture, state, directory }) => {
  const revived = fixture();
  await revived.start();
  const plantClaude = (id: string, parentId: string, stop?: string) => {
    const dir = join(state, "claude", id);
    mkdirSync(join(dir, "hooks"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "hooks", "UserPromptSubmit-1-1.json"), JSON.stringify({ session_id: "cs", transcript_path: join(dir, "transcript.jsonl") }));
    writeFileSync(join(dir, "transcript.jsonl"), stop ? JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] }) + "\n" : "");
    if (stop) writeFileSync(join(dir, "hooks", "Stop-2-2.json"), JSON.stringify({ session_id: "cs", last_assistant_message: stop }));
    atomicWrite(join(dir, "worker.json"), { workerId: id, parentId, role: "review", runtime: "claude", model: "claude-opus-5-5", effort: "high",
      cwd: directory, workspaceId: "w1", tabId: `tab-w1:${id}`, paneId: `w1:${id}`, terminalId: `term-w1:${id}`, launchId: "claude-launch",
      state: "open", task: { submissionId: `sub-${id}`, kind: "active", outcome: null, finalText: "", artifactPath: null, reason: null,
        claudeSessionId: "cs", transcriptPath: "/tmp/claude.jsonl", startedAt: new Date().toISOString() } });
  };
  const tool = async (name: string, params: unknown) => JSON.parse(toolText(await revived.tools.get(name).execute(name, params, undefined, undefined, revived.ctx)));
  plantClaude("cwaiting", "lead");
  const waitingPath = join(state, "claude", "cwaiting", "worker.json");
  const waiting = tool("wait_agent", { agent_id: "cwaiting", submission_id: "sub-cwaiting", timeout_ms: 120000 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const before = readFileSync(waitingPath, "utf8");
  await revived.stop();
  await assert.rejects(waiting, /abort|unavailable/i);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(readFileSync(waitingPath, "utf8"), before, "no Claude write after detachment");
}));
