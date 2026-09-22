// Real cross-process adapter launch race. Herdr/Pi launch is stubbed at the session-open boundary.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import adapter from "./index.ts";
import { atomicWrite } from "./protocol.ts";
import { runtimeSocket, socketDirectory } from "./startup.ts";

const file = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionHeader = id => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dirname(file) }) + "\n";

if (process.argv[2] === "contender") {
  const state = process.env.RACE_STATE;
  const worker = process.env.RACE_WORKER;
  const hooks = new Map();
  const tools = new Map();
  const pane = id => ({ pane_id: id, terminal_id: `term-${id}`, workspace_id: "w1", tab_id: `tab-${id}` });
  const ownSession = join(state, `${worker}.jsonl`);
  writeFileSync(ownSession, sessionHeader(`session-${worker}`));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SESSION_NAME: "slice", HERDR_SOCKET_PATH: "/fixture/herdr.sock", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: `w1:${worker}`, DS_HERDR_WORKER_ID: worker,
    DS_HERDR_ROLE: worker === "lead" ? "lead" : "implement", DS_HERDR_PARENT_ID: worker === "lead" ? "" : "lead",
    DS_HERDR_STATE_DIR: state, DS_HERDR_SESSION: "slice", DS_HERDR_WORKSPACE: dirname(file), DS_HERDR_RESTART_GENERATION: "" });
  delete process.env.DS_HERDR_WORKSPACE_ID;
  delete process.env.DS_HERDR_LAUNCH_ID;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const ctx = { cwd: dirname(file), mode: "tui", hasUI: false, model: { provider: "caller", id: "wrong-default", reasoning: true },
    modelRegistry: { find: (provider, id) => ({ provider, id, reasoning: true }),
      hasConfiguredAuth: () => true, getProviderAuthStatus: () => ({ configured: true }) },
    sessionManager: { getSessionFile: () => ownSession, getSessionId: () => `session-${worker}` },
    isIdle: () => true, hasPendingMessages: () => false, shutdown() {}, ui: { notify() {}, setWidget() {} } };
  const emit = async name => { for (const callback of hooks.get(name) ?? []) await callback({}, ctx); };
  adapter({
    on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, setThinkingLevel() {}, getThinkingLevel: () => "medium",
    async exec(_command, args) {
      const op = args.slice(args.indexOf("herdr") + 1);
      let result;
      if (op[0] === "tab") result = { root_pane: pane(`w1:new-${worker}`) };
      else if (op[1] === "get") result = { pane: pane(op[2]) };
      else if (op[0] === "agent") {
        const path = op[op.indexOf("--session") + 1];
        const model = op[op.indexOf("--model") + 1];
        // SDK initialization may write before session_start. This is the deliberately stubbed external boundary.
        writeFileSync(path, JSON.stringify({ type: "model_change", provider: "selected", modelId: model, opener: worker }) + "\n", { flag: "a" });
        process.send({ kind: "opened", worker, model, thinking: op[op.indexOf("--thinking") + 1] });
        await held;
        return { code: 1, killed: false, stderr: "fixture readiness unknown", stdout: "" };
      } else if (op[1] === "close") return { code: 1, killed: false, stderr: "fixture cleanup uncertain", stdout: "" };
      return { code: 0, killed: false, stderr: "", stdout: result ? JSON.stringify({ result }) : "" };
    },
  });
  process.on("message", async message => {
    if (message === "release") return release();
    if (message !== "go") return;
    try {
      await tools.get("followup_task").execute("race", { agent_id: "dead", task: "new task only" }, undefined, undefined, ctx);
      process.send({ kind: "result", worker, error: "unexpected success" });
    } catch (error) { process.send({ kind: "result", worker, error: String(error) }); }
    await emit("session_shutdown");
    process.disconnect();
  });
  await emit("session_start");
  process.send({ kind: "ready", worker });
} else {
  const directory = mkdtempSync(join(tmpdir(), "piha-race-"));
  const state = directory;
  const children = [];
  const messages = [];
  async function waitFor(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Race check deadline: ${JSON.stringify(messages)}`);
      await sleep(10);
    }
  }
  function start(worker) {
    const child = fork(file, ["contender"], { env: { ...process.env, RACE_STATE: state, RACE_WORKER: worker }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child);
    child.on("message", message => messages.push(message));
    return child;
  }
  try {
    const lead = start("lead");
    await waitFor(() => messages.some(message => message.kind === "ready" && message.worker === "lead"));
    const owner = start("owner");
    await waitFor(() => messages.some(message => message.kind === "ready" && message.worker === "owner"));
    const originalSession = join(state, "sessions", "dead.jsonl");
    const initial = sessionHeader("original-pi-uuid");
    writeFileSync(originalSession, initial);
    mkdirSync(join(state, "tasks", "dead"));
    const parent = JSON.parse(readFileSync(join(state, "workers", "owner.json")));
    atomicWrite(join(state, "workers", "dead.json"), { ...parent, workerId: "dead", parentId: "owner", generation: "old-generation",
      pidBirth: "proven-nonmatching-birth", piSessionId: "original-pi-uuid", piSessionPath: originalSession,
      socketPath: runtimeSocket(state, "old-generation", process.env.XDG_RUNTIME_DIR || "/tmp"), model: { provider: "original-provider", id: "assigned-model" }, thinking: "low" });
    lead.send("go");
    owner.send("go");
    await waitFor(() => messages.some(message => message.kind === "opened") && messages.some(message => message.kind === "result"));
    const opened = messages.filter(message => message.kind === "opened");
    assert.equal(opened.length, 1, "only one authorized ancestor crosses native session-open boundary");
    assert.equal(opened[0].model, "original-provider/assigned-model", "no-message revival explicitly uses original model, not caller/default");
    assert.equal(opened[0].thinking, "low", "cold continuation keeps saved effort, not role default");
    const claim = JSON.parse(readFileSync(join(state, "locks", "launch-dead", "claim.json")));
    assert.deepEqual(claim.model, { provider: "original-provider", id: "assigned-model" });
    assert.equal(claim.thinking, "low");
    assert.match(messages.find(message => message.kind === "result").error, /EEXIST/);
    const entries = readFileSync(originalSession, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(entries.length, 2, "losing attempt never appends pre-hook SDK metadata");
    assert.equal(entries[0].id, "original-pi-uuid");
    for (const child of children) if (child.connected) child.send("release");
    await waitFor(() => messages.filter(message => message.kind === "result").length === 2);
    assert.ok(messages.some(message => message.kind === "result" && /cleanup uncertain/.test(message.error)));
    assert.ok(existsSync(join(state, "locks", "launch-dead", "claim.json")), "uncertain startup/cleanup keeps per-worker fence");
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      assert.equal(child.exitCode, 0, "contender completed lifecycle cleanup");
    }
    process.stdout.write("PASS real cross-process authorized-ancestor race; one stubbed native session open, original UUID/model preserved, losing write refused, uncertain claim retained. No native Pi/Herdr or model calls.\n");
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(socketDirectory(state, process.env.XDG_RUNTIME_DIR || "/tmp"), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
