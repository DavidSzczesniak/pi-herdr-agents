// Real files/sockets/process identities and Pi discovery/headless binding. TUI/Herdr controls are stubbed.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "./index.ts";
import { startupConfig, extensionPath, privateDirectory } from "./startup.ts";
import { atomicWrite, request } from "./protocol.ts";

// Root doubles as XDG_RUNTIME_DIR. macOS tmpdir() is too long for the 103-byte socket limit.
const root = mkdtempSync("/tmp/pha-");
const stateRoot = join(root, "long-durable-state-" + "x".repeat(140));
const project = join(root, "project");
mkdirSync(project);
const fixtures = [];
function fixture({ id = "session-a", mode = "tui", persistent = true, env = {}, fail = false } = {}) {
  const sessionFile = join(root, `${id}.jsonl`);
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", id }) + "\n");
  const environment = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/exact/default.sock", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1",
    XDG_STATE_HOME: stateRoot, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: join(root, "pi-config"), ...env };
  const hooks = new Map(), tools = new Map(), widgets = new Map();
  const commands = [], notifications = [];
  let selected = ["read", "bash", "my-selected-tool"], changes = 0, shutdowns = 0;
  const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", cwd: project, model: { provider: "fixture", id: "no-network", reasoning: true },
    modelRegistry: { find: (provider, id) => ({ provider, id, reasoning: true }),
      hasConfiguredAuth: () => true, getProviderAuthStatus: () => ({ configured: true }) },
    sessionManager: { getSessionFile: () => persistent ? sessionFile : undefined, getSessionId: () => id },
    isIdle: () => true, hasPendingMessages: () => false, shutdown() { shutdowns++; },
    ui: { notify(message) { notifications.push(message); }, setWidget(key, value) { widgets.set(key, value); } } };
  const api = {
    on(name, fn) { hooks.set(name, [...hooks.get(name) || [], fn]); }, registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    getActiveTools: () => selected, setActiveTools(value) { selected = value; changes++; },
    getThinkingLevel: () => "high", setThinkingLevel() {}, appendEntry() {},
    async exec(command, args) {
      commands.push({ command, args });
      assert.equal(command, "env");
      assert.deepEqual(args.slice(0, 4), ["-u", "HERDR_SESSION_NAME", `HERDR_SOCKET_PATH=${environment.HERDR_SOCKET_PATH}`, "herdr"]);
      const op = args.slice(4);
      if (fail === true || (fail === "report" && op[1] === "report-agent")) return { code: 1, killed: false, stderr: "fixture startup fault", stdout: "" };
      if (op[0] === "agent") return { code: 1, killed: false, stderr: "fixture child failure", stdout: "" };
      const pane = { pane_id: op[2], workspace_id: "w1", terminal_id: "terminal-1", tab_id: "w1:t1" };
      const result = op[0] === "tab" ? { root_pane: { ...pane, pane_id: "w1:p-new" } } : { pane };
      return { code: 0, killed: false, stderr: "", stdout: op[1] === "get" || op[0] === "tab" ? JSON.stringify({ result }) : "" };
    },
  };
  const saved = { ...process.env };
  try {
    // Factory snapshots only. Runtime instances cannot use each other's environment.
    for (const key of Object.keys(process.env)) if (key.startsWith("DS_HERDR_") || key.startsWith("HERDR_")) delete process.env[key];
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    adapter(api);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const config = startupConfig(ctx, environment);
  const emit = async (name, event = {}) => {
    const results = [];
    for (const fn of [...hooks.get(name) || []]) results.push(await fn(event, ctx));
    return results;
  };
  const instance = { ctx, config, emit, tools, widgets, commands, notifications,
    get changes() { return changes; }, get shutdowns() { return shutdowns; },
    identity() { return JSON.parse(readFileSync(join(config.stateDir, "workers", `${config.workerId}.json`))); },
    start: () => emit("session_start", { reason: "startup" }), stop: () => emit("session_shutdown", { reason: "quit" }),
  };
  fixtures.push(instance);
  return instance;
}
async function inert(instance) {
  await instance.start();
  await instance.emit("agent_start");
  await instance.emit("agent_settled");
  const event = { prompt: "hello", systemPromptOptions: { promptGuidelines: [] } };
  await instance.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
  for (const name of ["input", "tool_call", "session_before_switch", "session_before_fork", "session_before_tree", "cache_warming_decision"])
    assert.ok((await instance.emit(name, {})).every(result => result === undefined));
  assert.equal(instance.tools.size, 0);
  assert.equal(instance.changes, 0);
  assert.equal(instance.shutdowns, 0);
  assert.equal(instance.commands.length, 0);
}
try {
  for (const mode of ["rpc", "json", "print", undefined]) {
    const instance = fixture({ mode: mode ?? "sdk" });
    await inert(instance);
  }
  await inert(fixture({ env: { HERDR_ENV: "0" } }));
  await inert(fixture({ persistent: false }));
  assert.equal(existsSync(stateRoot), false, "inert startup performs no runtime writes");
  const a = fixture();
  const b = fixture({ id: "session-b", env: { HERDR_SOCKET_PATH: "/exact/named.sock", HERDR_SESSION_NAME: "named" } });
  await a.start(); await b.start();
  assert.equal(a.tools.size, 7);
  assert.ok(a.tools.has("retire_agent"), "ordinary autoload discovers retirement without changing root tool selection");
  assert.equal(a.changes, 0, "root preserves user-selected tools");
  assert.notEqual(a.config.stateDir, b.config.stateDir);
  assert.notEqual(a.identity().socketPath, b.identity().socketPath);
  assert.ok(Buffer.byteLength(a.identity().socketPath) <= 103);
  assert.ok(a.config.stateDir.length > 200);
  assert.deepEqual(readdirSync(project), [], "runtime state never enters project");
  assert.equal(a.config.herdrSession, "", "default server needs no invented session name");
  const endpointScoped = fixture({ env: { HERDR_SOCKET_PATH: "/another/default.sock" } });
  assert.notEqual(endpointScoped.config.stateDir, a.config.stateDir);
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"])
    assert.deepEqual(await a.emit(event), [undefined]);
  await a.tools.get("update_plan").execute("plan", { plan: [{ step: "exact plan", status: "pending" }] }, undefined, undefined, a.ctx);
  const original = a.identity();
  const child = fixture({ id: "child-session", env: {
    HERDR_PANE_ID: "w1:p-child", DS_HERDR_WORKER_ID: "child", DS_HERDR_PARENT_ID: "lead", DS_HERDR_ROLE: "review",
    DS_HERDR_STATE_DIR: a.config.stateDir, DS_HERDR_SOCKET_DIR: a.config.socketDir, DS_HERDR_SESSION: "", DS_HERDR_WORKSPACE: project,
  } });
  await child.start();
  const childIdentity = child.identity();
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"])
    assert.deepEqual(await child.emit(event), [{ cancel: true }], "worker retains assigned conversation history");
  assert.deepEqual(await child.emit("tool_call", { toolName: "bash" }), [undefined], "review role has no shell ban");
  const duplicate = fixture();
  await duplicate.start();
  assert.match(duplicate.notifications[0], /still live/);
  assert.equal(duplicate.tools.size, 0);
  assert.equal(duplicate.shutdowns, 0);
  assert.equal(a.identity().generation, original.generation);
  assert.ok(existsSync(original.socketPath));
  await a.stop();
  const restored = fixture();
  // Native Pi leaves an empty session unflushed, even though getSessionFile returns its path.
  rmSync(restored.ctx.sessionManager.getSessionFile());
  await restored.emit("session_start", { reason: "reload" });
  assert.notEqual(restored.identity().generation, original.generation);
  assert.equal(restored.widgets.get("ds-plan")[0], "[ ] exact plan");
  const descendants = await restored.tools.get("list_agents").execute("list", {}, undefined);
  const listed = JSON.parse(descendants.content[0].text);
  assert.equal(listed[0].identity.generation, childIdentity.generation, "root reload preserves live descendants");
  assert.equal(listed[0].kind, "status");
  assert.equal(restored.shutdowns, 0);
  writeFileSync(restored.ctx.sessionManager.getSessionFile(), JSON.stringify({ type: "session", id: "session-a" }) + "\n");
  await restored.stop();
  // A crashed previous generation must pass death proof, never merely available:false.
  const saved = restored.identity();
  rmSync(join(restored.config.stateDir, "locks", "lead.detached.json"));
  atomicWrite(join(restored.config.stateDir, "workers", "lead.json"), { ...saved, available: true, pidBirth: "dead-generation" });
  const recovered = fixture();
  await recovered.emit("session_start", { reason: "resume" });
  assert.equal(recovered.tools.size, 7);
  assert.notEqual(recovered.identity().generation, saved.generation);
  const status = await request(recovered.identity().socketPath, { kind: "status", generation: recovered.identity().generation,
    callerId: "lead", callerGeneration: recovered.identity().generation });
  assert.equal(status.kind, "status");
  await assert.rejects(recovered.tools.get("spawn_agent").execute("child", { role: "implement", thinking: "medium", task: "new task" }, undefined, undefined, recovered.ctx), /fixture child failure/);
  const created = recovered.commands.find(({ args }) => args[4] === "tab").args;
  assert.ok(created.includes(`PI_CODING_AGENT_DIR=${join(root, "pi-config")}`));
  assert.ok(created.includes(`DS_HERDR_SOCKET_DIR=${recovered.config.socketDir}`));
  assert.ok(created.includes("HERDR_SOCKET_PATH=/exact/default.sock"));
  const started = recovered.commands.find(({ args }) => args[4] === "agent").args;
  assert.equal(started[started.indexOf("-e") + 1], extensionPath);
  assert.equal(extensionPath, fileURLToPath(new URL("./index.ts", import.meta.url)));
  assert.ok(!started.some(arg => arg.includes("/opt/adapter")));
  assert.equal(started[started.indexOf("--model") + 1], "fixture/no-network");
  // Herdr may type the launch command into a shell still in canonical mode; macOS truncates canonical input at 1024 bytes.
  const deep = fixture({ id: "deep-state", env: { XDG_STATE_HOME: join(root, "a".repeat(200), "b".repeat(200), "c".repeat(200)) } });
  await deep.start();
  await assert.rejects(deep.tools.get("spawn_agent").execute("child", { role: "implement", thinking: "medium", task: "t" }, undefined, undefined, deep.ctx), /launch command too long/);
  assert.ok(!deep.commands.some(({ args }) => args[4] === "tab"), "overlong launch refused before tab creation");
  assert.deepEqual(readdirSync(join(deep.config.stateDir, "locks")).filter(name => name.startsWith("launch-")), [], "overlong launch leaves no claim");
  await deep.stop();
  const defaultConfig = fixture({ id: "default-config", env: { HOME: root, PI_CODING_AGENT_DIR: undefined } });
  await defaultConfig.start();
  await assert.rejects(defaultConfig.tools.get("spawn_agent").execute("default-child", { role: "implement", thinking: "medium", task: "new task" }, undefined, undefined, defaultConfig.ctx), /fixture child failure/);
  const defaultLaunch = defaultConfig.commands.find(({ args }) => args[4] === "tab").args;
  assert.ok(defaultLaunch.includes(`PI_CODING_AGENT_DIR=${join(root, ".pi", "agent")}`),
    "unset config uses the lead's effective default, not Herdr server environment");
  const fault = fixture({ id: "fault", fail: true });
  await fault.start();
  assert.match(fault.notifications[0], /disabled.*startup fault/);
  assert.equal(fault.shutdowns, 0);
  assert.equal(fault.changes, 0);
  assert.equal(fault.tools.size, 0);
  assert.deepEqual(await fault.emit("input"), [undefined]);
  assert.deepEqual(await fault.emit("tool_call"), [undefined]);
  const guidelines = { systemPromptOptions: { promptGuidelines: [] } };
  await fault.emit("before_agent_start", guidelines);
  assert.deepEqual(guidelines.systemPromptOptions.promptGuidelines, []);
  const reportFault = fixture({ id: "report-fault", fail: "report" });
  await reportFault.start();
  assert.equal(reportFault.shutdowns, 0);
  assert.equal(reportFault.tools.size, 0);
  assert.equal(reportFault.identity().available, false);
  assert.equal(existsSync(reportFault.identity().socketPath), false, "post-claim startup failure closes its socket");
  assert.equal(existsSync(join(reportFault.config.stateDir, "locks", "lead")), false);
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  // Exercise actual Pi package discovery and SDK/RPC binding without providers or Herdr.
  const { DefaultResourceLoader, createAgentSession, ModelRuntime, SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const agentDir = join(root, "sdk-config");
  const settingsManager = SettingsManager.inMemory({ packages: [fileURLToPath(new URL(".", import.meta.url))] });
  const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().extensions.map(extension => extension.path), [extensionPath], "real Pi manifest discovers only main extension");
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  for (const mode of [undefined, "rpc", "print", "json"]) {
    const errors = [];
    const { session } = await createAgentSession({ cwd: project, agentDir, resourceLoader: loader, modelRuntime,
      settingsManager, tools: ["read"], sessionManager: SessionManager.create(project, join(root, "sdk-sessions")) });
    try {
      await session.bindExtensions({ ...(mode ? { mode } : {}), onError: error => errors.push(error) });
      assert.deepEqual(errors, []);
      assert.deepEqual(session.getActiveToolNames(), ["read"], "real headless binding preserves tools");
      assert.ok(!session.getAllTools().some(tool => tool.name === "spawn_agent"));
    } finally { session.dispose(); }
    await loader.reload();
  }
  const unsafe = join(root, "unsafe"); mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => privateDirectory(unsafe), /private/);
  process.stdout.write("PASS automatic startup, inert modes, isolation, short sockets, endpoint routing, portable launch, duplicate refusal, clean reload, dead-root recovery, real Pi package discovery and headless SDK binding. No native Herdr/model calls.\n");
} finally {
  for (const fixture of fixtures.reverse()) await fixture.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
