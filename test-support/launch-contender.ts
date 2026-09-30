import { join } from "node:path";
import { writeFileSync } from "node:fs";
import adapter from "../index.ts";
import { fakeApi, fakeContext, fakeModel, fakeModelRegistry, fakeSessions, fakeUi, hookRegistry, toolRegistry, fakePane as pane, herdrArgs, herdrResult, execOk, execFailure } from "../fakes.ts";

export type RaceMessage = { kind: "ready"; worker: string } | { kind: "opened"; worker: string; model: string; thinking: string } | { kind: "result"; worker: string; error: string };
const required = (value: string | undefined, name: string) => { if (value === undefined) throw new Error(`${name} is unset`); return value; };
const packageDir = required(process.env.RACE_PACKAGE_DIR, "RACE_PACKAGE_DIR");
const sessionHeader = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: packageDir }) + "\n";
const send = (message: RaceMessage) => { if (!process.send) throw new Error("contender runs without an IPC channel"); process.send(message); };
const state = required(process.env.RACE_STATE, "RACE_STATE");
const worker = required(process.env.RACE_WORKER, "RACE_WORKER");
if (worker !== "lead" && worker !== "owner") throw new Error("unknown race worker");
const hooks = hookRegistry();
const tools = toolRegistry();
const ownSession = join(state, `${worker}.jsonl`);
writeFileSync(ownSession, sessionHeader(`session-${worker}`));
Object.assign(process.env, { HERDR_ENV: "1", HERDR_SESSION: "slice", HERDR_SOCKET_PATH: "/fixture/herdr.sock", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: `w1:${worker}`, DS_HERDR_WORKER_ID: worker,
  DS_HERDR_ROLE: worker === "lead" ? "lead" : "implement", DS_HERDR_PARENT_ID: worker === "lead" ? "" : "lead",
  DS_HERDR_STATE_DIR: state, DS_HERDR_SESSION: "slice", DS_HERDR_WORKSPACE: packageDir, DS_HERDR_RESTART_GENERATION: "" });
delete process.env.DS_HERDR_WORKSPACE_ID;
delete process.env.DS_HERDR_LAUNCH_ID;
let release = () => {};
const held = new Promise(resolve => { release = () => resolve(undefined); });
const ctx = fakeContext({ cwd: packageDir, mode: "tui", hasUI: false, signal: undefined, model: fakeModel("caller", "wrong-default"),
  modelRegistry: fakeModelRegistry({ auth: true }),
  sessionManager: fakeSessions({ getSessionFile: () => ownSession, getSessionId: () => `session-${worker}` }),
  isIdle: () => true, hasPendingMessages: () => false, shutdown() {}, ui: fakeUi({ notify() {}, setWidget() {} }) });
adapter(fakeApi({
  on: hooks.on,
  registerTool: tools.register,
  registerCommand() {},
  getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, setThinkingLevel() {}, getThinkingLevel: () => "medium",
  async exec(_command, args) {
    const op = herdrArgs(args);
    let result;
    if (op[0] === "tab") result = { root_pane: pane(`w1:new-${worker}`) };
    else if (op[1] === "get") result = { pane: pane(required(op[2], "pane id")) };
    else if (op[0] === "agent") {
      const path = required(op[op.indexOf("--session") + 1], "--session");
      const model = required(op[op.indexOf("--model") + 1], "--model");
      // SDK initialization may write before session_start. This is the deliberately stubbed external boundary.
      writeFileSync(path, JSON.stringify({ type: "model_change", provider: "selected", modelId: model, opener: worker }) + "\n", { flag: "a" });
      send({ kind: "opened", worker, model, thinking: required(op[op.indexOf("--thinking") + 1], "--thinking") });
      await held;
      return execFailure("fixture readiness unknown");
    } else if (op[1] === "close") return execFailure("fixture cleanup uncertain");
    return result ? herdrResult(result) : execOk();
  },
}));
process.on("message", async message => {
  if (message === "release") return release();
  if (message !== "go") return;
  try {
    await tools.get("followup_task").execute("race", { agent_id: "dead", task: "new task only" }, undefined, undefined, ctx);
    send({ kind: "result", worker, error: "unexpected success" });
  } catch (error) { send({ kind: "result", worker, error: String(error) }); }
  await hooks.emit({ type: "session_shutdown", reason: "quit" }, ctx);
  process.disconnect();
});
await hooks.emit({ type: "session_start", reason: "startup" }, ctx);
send({ kind: "ready", worker });
