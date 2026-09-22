// Real cross-process adapter launch race. Herdr/Pi launch is stubbed at the session-open boundary.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "./index.ts";
import { atomicWrite } from "./protocol.ts";

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
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: `w1:${worker}`, DS_HERDR_WORKER_ID: worker,
    DS_HERDR_ROLE: worker === "lead" ? "lead" : "implement", DS_HERDR_PARENT_ID: worker === "lead" ? "" : "lead",
    DS_HERDR_STATE_DIR: state, DS_HERDR_SESSION: "slice", DS_HERDR_WORKSPACE: dirname(file), DS_HERDR_RESTART_GENERATION: "" });
  delete process.env.DS_HERDR_WORKSPACE_ID;
  delete process.env.DS_HERDR_LAUNCH_ID;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const ctx = { cwd: dirname(file), hasUI: false, model: { provider: "caller", id: "wrong-default" },
    sessionManager: { getSessionFile: () => ownSession, getSessionId: () => `session-${worker}` },
    isIdle: () => true, hasPendingMessages: () => false, shutdown() {}, ui: { notify() {} } };
  const emit = async name => { for (const callback of hooks.get(name) ?? []) await callback({}, ctx); };
  adapter({
    on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, setThinkingLevel() {}, getThinkingLevel: () => "medium",
    async exec(_command, args) {
      const op = args.slice(2);
      let result;
      if (op[0] === "tab") result = { root_pane: pane(`w1:new-${worker}`) };
      else if (op[1] === "get") result = { pane: pane(op[2]) };
      else if (op[0] === "agent") {
        const path = op[op.indexOf("--session") + 1];
        const model = op[op.indexOf("--model") + 1];
        // SDK initialization may write before session_start. This is the deliberately stubbed external boundary.
        writeFileSync(path, JSON.stringify({ type: "model_change", provider: "selected", modelId: model, opener: worker }) + "\n", { flag: "a" });
        process.send({ kind: "opened", worker, model });
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
  const directory = mkdtempSync(join(dirname(file), ".launch-race-"));
  const fd = openSync(directory, "r");
  const state = `/proc/${process.pid}/fd/${fd}`;
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
      socketPath: join(state, "sockets", "dead-old-generation.sock"), model: { provider: "original-provider", id: "assigned-model" } });
    lead.send("go");
    owner.send("go");
    await waitFor(() => messages.some(message => message.kind === "opened") && messages.some(message => message.kind === "result"));
    const opened = messages.filter(message => message.kind === "opened");
    assert.equal(opened.length, 1, "only one authorized ancestor crosses native session-open boundary");
    assert.equal(opened[0].model, "original-provider/assigned-model", "no-message revival explicitly uses original model, not caller/default");
    assert.match(messages.find(message => message.kind === "result").error, /EEXIST/);
    const entries = readFileSync(originalSession, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(entries.length, 2, "losing attempt never appends pre-hook SDK metadata");
    assert.equal(entries[0].id, "original-pi-uuid");
    for (const child of children) if (child.connected) child.send("release");
    await waitFor(() => messages.filter(message => message.kind === "result").length === 2);
    assert.ok(messages.some(message => message.kind === "result" && /cleanup uncertain/.test(message.error)));
    assert.ok(existsSync(join(state, "locks", "launch-dead", "claim.json")), "uncertain startup/cleanup keeps per-worker fence");
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    process.stdout.write("PASS real cross-process authorized-ancestor race; one stubbed native session open, original UUID/model preserved, losing write refused, uncertain claim retained. No native Pi/Herdr or model calls.\n");
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}
