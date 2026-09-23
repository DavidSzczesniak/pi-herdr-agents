// Herdr and Pi controls are stubbed; sockets, persistence, and PID/birth checks are real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter from "./index.ts";
import { request } from "./protocol.ts";
import { socketDirectory } from "./startup.ts";
import { claimLaunch, isOriginalProcessLive, processIdentity } from "./runtime.ts";
import { atomicWrite } from "./protocol.ts";

const directory = process.env.RETIRE_STATE || mkdtempSync(join(tmpdir(), "piha-retire-"));
const originalEnv = { ...process.env };
const identities = new Map();
const closed = new Set();
const faults = new Map();
let startResumed;
let createdId;
let cleanupAbort;
let abortPoint;
const pane = id => ({ pane_id: `w:p-${id}`, workspace_id: "w", tab_id: `tab-${id}`, terminal_id: `term-${id}` });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = id => JSON.parse(readFileSync(join(directory, "workers", `${id}.json`), "utf8"));
const query = (who, kind, rest = {}) => request(who.socketPath, { kind, callerId: "lead", callerGeneration: identity("lead").generation,
  generation: who.generation, ...rest });
const inChild = process.argv[2] === "child";
const id = inChild ? process.argv[3] : "lead";
const mode = inChild ? process.argv[4] : "idle";
const parent = inChild ? process.argv[5] : "";
const configEnv = { DS_HERDR_STATE_DIR: process.env.RETIRE_STATE || directory, DS_HERDR_SESSION: "fixture", DS_HERDR_WORKSPACE: process.env.RETIRE_STATE || directory,
  DS_HERDR_WORKER_ID: id, DS_HERDR_ROLE: inChild ? "implement" : "lead", DS_HERDR_PARENT_ID: parent,
  HERDR_ENV: "1", HERDR_SESSION: "fixture", HERDR_SOCKET_PATH: "/fixture/retirement.sock", HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: pane(process.env.RETIRE_NEW_PANE ? `${id}-new` : id).pane_id };
if (inChild) {
  Object.assign(process.env, configEnv);
  delete process.env.DS_HERDR_WORKSPACE_ID;
  if (mode !== "resume") {
    delete process.env.DS_HERDR_LAUNCH_ID;
    delete process.env.DS_HERDR_RESTART_GENERATION;
  }
} else {
  mkdirSync(join(directory, "sessions"), { mode: 0o700 });
  Object.assign(process.env, configEnv);
  delete process.env.DS_HERDR_WORKSPACE_ID;
  delete process.env.DS_HERDR_LAUNCH_ID;
  delete process.env.DS_HERDR_RESTART_GENERATION;
}
function native() {
  const hooks = new Map();
  const tools = new Map();
  const file = join(process.env.RETIRE_STATE || directory, "sessions", `${id}.jsonl`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: `pi-${id}`, cwd: process.env.RETIRE_STATE || directory }) + "\n");
  let active = false;
  let queued = mode === "queued";
  const ctx = { cwd: process.env.RETIRE_STATE || directory, mode: "tui", hasUI: true,
    model: mode === "noauth" ? null : { provider: "fixture", id: "model", reasoning: true },
    modelRegistry: { find: (provider, name) => ({ provider, id: name, reasoning: true }),
      hasConfiguredAuth: () => true, getProviderAuthStatus: () => ({ configured: true }) },
    sessionManager: { getSessionFile: () => file, getSessionId: () => `pi-${id}` },
    isIdle: () => !active, hasPendingMessages: () => queued,
    shutdown: () => { if (inChild && mode !== "no-shutdown") void emit("session_shutdown").then(() => process.exit(0)); },
    ui: { notify(message) { throw new Error(message); }, setWidget() {} },
  };
  const emit = async (name, event = {}) => { for (const hook of hooks.get(name) || []) await hook(event, ctx); };
  const api = { on(name, fn) { hooks.set(name, [...(hooks.get(name) || []), fn]); }, registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {}, getActiveTools: () => ["read", "bash"], setActiveTools() {}, getThinkingLevel: () => "medium",
    async exec(_command, args) {
      const op = args.slice(args.indexOf("herdr") + 1);
      if (op[0] === "tab" && op[1] === "create") {
        createdId = op.find(value => value.startsWith("DS_HERDR_WORKER_ID=")).split("=")[1];
        return response({ result: { root_pane: pane(`${createdId}-new`) } });
      }
      if (op[0] === "agent" && op[1] === "start") {
        await startResumed?.(op);
        return response({});
      }
      if (op[0] === "pane" && op[1] === "get") return response({ result: { pane: pane(op[2].slice(4)) } });
      if (op[0] === "pane" && op[1] === "list") {
        if (abortPoint === "after-close-list" && closed.has("abort-after-close")) cleanupAbort.abort();
        return response({ result: { panes: [...identities.keys()].filter(key => !closed.has(key))
          .filter(key => faults.get(key) !== "absent" || isOriginalProcessLive(identity(key)))
          .map(key => faults.get(key) === "moved" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), tab_id: "other-tab" } :
            faults.get(key) === "terminal" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), terminal_id: "replacement" } :
              faults.get(key) === "workspace-move" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), workspace_id: "other-workspace" } :
                faults.get(key) === "pane-id-move" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), pane_id: "w:p-relocated" } : pane(key)) } });
      }
      if (op[0] === "tab" && op[1] === "get") return response({ result: { tab: { tab_id: op[2], workspace_id: "w", pane_count: 1 } } });
      if (op[0] === "pane" && op[1] === "process-info") {
        const key = op[3].slice(4);
        if (abortPoint === "process-info" && key === "cleanup-abort") cleanupAbort.abort();
        const fault = faults.get(key);
        const info = { pane_id: op[3], shell_pid: fault === "null-shell" ? null : 1,
          foreground_process_group_id: fault === "null-group" ? null : fault === "foreign-group" || fault === "empty-foreground" ? 2 : 1,
          foreground_processes: fault === "empty-foreground" ? [] : [{ pid: fault === "occupant" || fault === "foreign-process" ? 2 : 1, name: "process" }] };
        if (fault === "missing-group") delete info.foreground_process_group_id;
        if (fault === "missing-foreground") delete info.foreground_processes;
        return response({ result: { process_info: info } });
      }
      if (op[0] === "pane" && op[1] === "close") {
        closed.add(op[2].slice(4));
        if (abortPoint === "close" && op[2] === "w:p-abort-after-close") cleanupAbort.abort();
        if (op[2] === "w:p-close-error") return { code: 1, killed: false, stdout: "", stderr: "fixture close response lost" };
        return response(null);
      }
      return response(null);
    },
    sendUserMessage(text) { active = true;
      if (mode === "resume") void (async () => {
        await emit("input", { source: "extension", text });
        await emit("before_agent_start", { prompt: text, systemPromptOptions: { promptGuidelines: [] } });
        await emit("agent_start");
      })();
    }, appendEntry() {},
  };
  function response(value) { return { code: 0, killed: false, stdout: value ? JSON.stringify(value) : "", stderr: "" }; }
  adapter(api);
  return { tools, ctx, emit, setQueued(value) { queued = value; } };
}
if (inChild) {
  const fixture = native();
  await fixture.emit("session_start");
  if (mode === "busy" || mode === "pending") {
    await request(identity(id).socketPath, { kind: "submit", callerId: id, callerGeneration: identity(id).generation,
      generation: identity(id).generation, submissionId: `task-${id}`, task: "do not retire" });
  }
  writeFileSync(join(process.env.RETIRE_STATE, `${id}.ready`), "ready");
  setInterval(() => {}, 1000);
} else {
  const children = [];
  const exits = [];
  const fixture = native();
  try {
    await fixture.emit("session_start");
    assert.ok(fixture.tools.has("retire_agent"));
    async function child(childId, childMode = "idle", parentId = "lead", extraEnv = {}) {
      rmSync(join(directory, `${childId}.ready`), { force: true });
      const proc = spawn(process.execPath, ["--experimental-strip-types", new URL(import.meta.url).pathname, "child", childId, childMode, parentId],
        { env: { ...originalEnv, RETIRE_STATE: directory, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      children.push(proc);
      exits.push(once(proc, "exit"));
      let stderr = "";
      proc.stderr.on("data", chunk => { stderr += chunk; });
      for (let i = 0; !existsSync(join(directory, `${childId}.ready`)) && proc.exitCode === null && i < 200; i++) await delay(50);
      assert.ok(existsSync(join(directory, `${childId}.ready`)), `${childId} failed to start: ${stderr}`);
      identities.set(childId, identity(childId));
      return proc;
    }
    startResumed = async op => {
      const claim = JSON.parse(readFileSync(join(directory, "locks", `launch-${createdId}`, "claim.json")));
      await child(createdId, "resume", "lead", { DS_HERDR_LAUNCH_ID: claim.launchId,
        DS_HERDR_RESTART_GENERATION: claim.previousGeneration, RETIRE_NEW_PANE: "1" });
    };
    const retire = async childId => JSON.parse((await fixture.tools.get("retire_agent").execute("retire", { agent_id: childId }, undefined, undefined, fixture.ctx)).content[0].text);
    await child("idle");
    const old = identity("idle");
    const retired = await retire("idle");
    assert.equal(retired.state, "retired");
    assert.equal(retired.deathVerified, true);
    assert.equal(retired.paneClosed, true);
    assert.ok(closed.has("idle"));
    assert.equal((await retire("idle")).state, "retired");
    const finishedPath = join(directory, "operations", `retire-idle-${old.generation}.json`);
    const finished = JSON.parse(readFileSync(finishedPath, "utf8"));
    atomicWrite(finishedPath, { ...finished, result: { ...finished.result, deathVerified: false } });
    await assert.rejects(retire("idle"), /Invalid protocol or persisted record/,
      "a finished result without all three proofs cannot be accepted");
    atomicWrite(finishedPath, finished);
    const strandedFence = join(directory, "locks", "retire-idle");
    mkdirSync(strandedFence); // Caller lost after atomic finished record, before fence removal.
    const fenceClaim = join(strandedFence, "claim.json");
    atomicWrite(fenceClaim, { workerId: "idle", generation: "other-generation",
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath });
    await assert.rejects(retire("idle"), /different conversation or generation/);
    assert.ok(existsSync(strandedFence), "mismatched fence is never removed");
    atomicWrite(fenceClaim, { workerId: "idle", generation: old.generation,
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath });
    const inFlight = join(strandedFence, "inflight");
    mkdirSync(inFlight);
    const birth = processIdentity(process.pid);
    assert.ok(birth);
    atomicWrite(join(inFlight, "owner.json"), { workerId: "idle", generation: old.generation,
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath,
      pid: process.pid, pidBirth: birth.birth, token: "conflicting-owner" });
    await assert.rejects(retire("idle"), /already active/, "do not remove a live operation's fence");
    assert.ok(existsSync(strandedFence));
    atomicWrite(join(inFlight, "owner.json"), { workerId: "idle", generation: old.generation,
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath,
      pid: process.pid, pidBirth: "dead-original-birth", token: "abandoned-owner" });
    assert.equal((await retire("idle")).state, "retired", "a dead lease allows exclusive finished-fence recovery");
    assert.equal(existsSync(strandedFence), false, "finished receipt retry must remove its stranded fence");
    const idleFollowup = JSON.parse((await fixture.tools.get("followup_task").execute("idle-cold", {
      agent_id: "idle", task: "only new work after finished fence cleanup",
    }, undefined, undefined, fixture.ctx)).content[0].text);
    assert.equal(idleFollowup.kind, "accepted");
    assert.equal(idleFollowup.identity.piSessionId, old.piSessionId);
    assert.notEqual(idleFollowup.identity.generation, old.generation);
    assert.equal(idleFollowup.identity.model.id, old.model.id);
    assert.equal(idleFollowup.identity.thinking, old.thinking);
    assert.equal(identity("idle").piSessionId, old.piSessionId);
    assert.equal(identity("idle").model.id, "model");
    const busy = await child("busy", "busy");
    await assert.rejects(retire("busy"), /Retirement refused/);
    assert.ok(!closed.has("busy"));
    await child("race");
    const raceTarget = identity("race");
    const race = await Promise.allSettled([
      retire("race"),
      query(raceTarget, "submit", { submissionId: "racing-task", task: "one task" }),
    ]);
    const retirementWon = race[0].status === "fulfilled" && race[0].value.state === "retired";
    const submissionWon = race[1].status === "fulfilled" && race[1].value.kind !== "unavailable";
    assert.notEqual(retirementWon, submissionWon, "retirement and submit must not both succeed or both vanish");
    await child("followup-race");
    const followup = await Promise.allSettled([
      retire("followup-race"),
      fixture.tools.get("followup_task").execute("new", { agent_id: "followup-race", task: "only new work" }, undefined, undefined, fixture.ctx),
    ]);
    if (followup.every(outcome => outcome.status === "fulfilled") && followup[0].value.state === "retired") {
      const next = JSON.parse(followup[1].value.content[0].text);
      assert.notEqual(next.generation, followup[0].value.generation,
        "a follow-up after retirement must use a new generation, never the retiring writer");
    }
    const queued = await child("queued", "queued");
    await assert.rejects(retire("queued"), /Retirement refused/);
    const pending = await child("pending", "pending");
    await assert.rejects(retire("pending"), /Retirement refused/);
    const ancestor = await child("ancestor");
    const leaf = await child("leaf", "idle", "ancestor");
    await assert.rejects(retire("ancestor"), /Descendant leaf live/);
    assert.equal((await retire("leaf")).state, "retired");
    const ancestorIdentity = identity("ancestor");
    const childClaim = claimLaunch(directory, { launchId: "ghost-launch", workerId: "ghost", previousGeneration: null,
      piSessionPath: join(directory, "sessions", "ghost.jsonl"), model: { provider: "fixture", id: "model" },
      thinking: "medium", callerId: "ancestor", callerGeneration: ancestorIdentity.generation,
      pid: ancestorIdentity.pid, pidBirth: ancestorIdentity.pidBirth });
    await assert.rejects(retire("ancestor"), /In-flight descendant launch/);
    childClaim.release();
    assert.equal((await retire("ancestor")).state, "retired");
    assert.ok(!closed.has("busy"));
    const stuck = await child("stuck", "no-shutdown");
    const abort = new AbortController();
    const operation = fixture.tools.get("retire_agent").execute("retire", { agent_id: "stuck" }, abort.signal, undefined, fixture.ctx);
    setTimeout(() => abort.abort(), 150);
    const incomplete = JSON.parse((await operation).content[0].text);
    assert.equal(incomplete.state, "incomplete");
    assert.equal(incomplete.shutdownRequested, true);
    assert.equal(incomplete.deathVerified, false);
    assert.ok(existsSync(join(directory, "locks", "retire-stuck")));
    assert.ok(!closed.has("stuck"));
    assert.throws(() => claimLaunch(directory, { launchId: "blocked", workerId: "stuck", previousGeneration: identity("stuck").generation,
      piSessionPath: join(directory, "sessions", "stuck.jsonl"), model: { provider: "fixture", id: "model" },
      thinking: "medium", callerId: "lead", callerGeneration: identity("lead").generation,
      pid: identity("lead").pid, pidBirth: identity("lead").pidBirth }), /Retirement unresolved/);
    assert.ok(stuck.exitCode === null);
    const stopped = once(stuck, "exit");
    stuck.kill("SIGTERM");
    await stopped;
    assert.equal((await retire("stuck")).state, "retired", "cleanup retry must not resend a task");
    await child("noauth", "noauth");
    assert.equal((await retire("noauth")).state, "retired", "retirement needs no current model or auth");
    await child("historical");
    const oldTask = { kind: "settled", workerId: "historical", generation: identity("historical").generation,
      piSessionId: "pi-historical", submissionId: "old-result", task: "original task", startedAt: "before",
      outcome: "completed", settledAt: "after", finalText: "exact historical result", artifactPath: join(directory, "artifact.md") };
    const taskFile = join(directory, "tasks", "historical", "old-result.json");
    atomicWrite(taskFile, oldTask);
    assert.equal((await retire("historical")).state, "retired");
    assert.deepEqual(JSON.parse(readFileSync(taskFile, "utf8")), oldTask, "retirement must not rewrite settled records");
    const revived = JSON.parse((await fixture.tools.get("followup_task").execute("cold", { agent_id: "historical", task: "only the new task" }, undefined, undefined, fixture.ctx)).content[0].text);
    assert.equal(revived.kind, "accepted");
    assert.equal(revived.identity.piSessionId, "pi-historical");
    assert.equal(revived.identity.workerId, "historical");
    assert.notEqual(revived.identity.generation, oldTask.generation);
    assert.equal(revived.identity.thinking, "medium");
    assert.equal(revived.identity.model.id, "model");
    assert.deepEqual(JSON.parse(readFileSync(taskFile, "utf8")), oldTask);
    assert.equal((await query(identity("historical"), "wait", { submissionId: "old-result", timeoutMs: 10 })).finalText, "exact historical result");
    const replaced = await child("replaced");
    faults.set("replaced", "occupant");
    const replacement = await retire("replaced");
    assert.equal(replacement.state, "incomplete");
    assert.equal(replacement.deathVerified, true);
    assert.ok(!closed.has("replaced"));
    faults.delete("replaced");
    assert.equal((await retire("replaced")).state, "retired");
    const moved = await child("moved");
    faults.set("moved", "moved");
    assert.equal((await retire("moved")).state, "incomplete");
    assert.ok(!closed.has("moved"));
    faults.delete("moved");
    assert.equal((await retire("moved")).state, "retired");
    await child("terminal");
    faults.set("terminal", "terminal");
    assert.equal((await retire("terminal")).state, "incomplete");
    assert.ok(!closed.has("terminal"));
    faults.delete("terminal");
    assert.equal((await retire("terminal")).state, "retired");
    await child("absent");
    faults.set("absent", "absent");
    assert.equal((await retire("absent")).state, "retired", "Server-wide pane absence after death is sufficient");
    assert.ok(!closed.has("absent"), "already absent pane is never closed by guessed ID");
    for (const fault of ["workspace-move", "pane-id-move"]) {
      await child(fault);
      faults.set(fault, fault);
      const result = await retire(fault);
      assert.equal(result.state, "incomplete", `${fault} must not count as absence`);
      assert.equal(result.deathVerified, true);
      assert.equal(result.paneClosed, false);
      assert.ok(!closed.has(fault));
      faults.delete(fault);
      assert.equal((await retire(fault)).state, "retired");
    }
    for (const fault of ["empty-foreground", "missing-foreground", "missing-group", "null-group", "null-shell", "foreign-group", "foreign-process"]) {
      await child(fault);
      faults.set(fault, fault);
      const result = await retire(fault);
      assert.equal(result.state, "incomplete", `${fault} does not affirm a foreground shell`);
      assert.ok(!closed.has(fault), `${fault} must leave the pane alone`);
      faults.delete(fault);
      assert.equal((await retire(fault)).state, "retired");
    }
    await child("cleanup-abort");
    cleanupAbort = new AbortController();
    abortPoint = "process-info";
    const abortedBeforeClose = JSON.parse((await fixture.tools.get("retire_agent").execute("abort-cleanup", {
      agent_id: "cleanup-abort" }, cleanupAbort.signal, undefined, fixture.ctx)).content[0].text);
    assert.equal(abortedBeforeClose.state, "incomplete");
    assert.equal(abortedBeforeClose.deathVerified, true);
    assert.equal(abortedBeforeClose.paneClosed, false);
    assert.ok(!closed.has("cleanup-abort"));
    abortPoint = undefined;
    assert.equal((await retire("cleanup-abort")).state, "retired");
    await child("abort-after-close");
    cleanupAbort = new AbortController();
    abortPoint = "close";
    const abortedAfterClose = JSON.parse((await fixture.tools.get("retire_agent").execute("abort-after-close", {
      agent_id: "abort-after-close" }, cleanupAbort.signal, undefined, fixture.ctx)).content[0].text);
    assert.equal(abortedAfterClose.state, "incomplete");
    assert.equal(abortedAfterClose.deathVerified, true);
    assert.equal(abortedAfterClose.paneClosed, true, "observed closure survives cancellation");
    assert.ok(closed.has("abort-after-close"));
    abortPoint = undefined;
    assert.equal((await retire("abort-after-close")).state, "retired", "retry verifies absence without another close");
    await child("close-error");
    const uncertainClose = await retire("close-error");
    assert.equal(uncertainClose.state, "incomplete", "close command failure is not a successful retirement");
    assert.equal(uncertainClose.paneClosed, true, "observed absence survives a lost close response");
    assert.equal((await retire("close-error")).state, "retired");
    await child("reload-pending", "no-shutdown");
    const reloadAbort = new AbortController();
    const outbound = fixture.tools.get("retire_agent").execute("reload", { agent_id: "reload-pending" },
      reloadAbort.signal, undefined, fixture.ctx);
    const evidence = join(directory, "operations", `retire-reload-pending-${identity("reload-pending").generation}.json`);
    for (let i = 0; !existsSync(evidence) && i < 100; i++) await delay(10);
    assert.ok(existsSync(evidence), "retirement must reserve before caller shutdown");
    let cleaned = false;
    const shuttingDown = fixture.emit("session_shutdown").then(() => { cleaned = true; });
    await delay(30);
    assert.equal(cleaned, false, "caller cleanup waits for its outbound retirement to record an outcome");
    reloadAbort.abort();
    const aborted = JSON.parse((await outbound).content[0].text);
    assert.equal(aborted.state, "incomplete");
    await shuttingDown;
    assert.equal(cleaned, true);
    assert.equal(JSON.parse(readFileSync(evidence, "utf8")).kind, "incomplete");
    assert.ok(existsSync(join(directory, "locks", "retire-reload-pending")), "reload leaves unresolved worker fenced");
    process.stdout.write("PASS retirement contracts with stubbed Pi/Herdr, real UDS and process death. No native integration claim.\n");
  } finally {
    for (const proc of children) if (proc.exitCode === null) proc.kill("SIGTERM");
    await Promise.all(exits);
    await fixture.emit("session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(socketDirectory(directory, originalEnv.XDG_RUNTIME_DIR || "/tmp"), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
