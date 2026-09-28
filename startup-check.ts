// Real files/sockets/process identities and Pi discovery/headless binding. TUI/Herdr controls are stubbed.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "./index.ts";
import { startupConfig, extensionPath, privateDirectory } from "./startup.ts";
import { atomicWrite, request } from "./protocol.ts";
import type { ExtensionEvent, ExtensionError } from "@earendil-works/pi-coding-agent";
import { fakeApi, fakeContext, fakeModel, fakeRegistry, fakeSessions, fakeUi, hookRegistry, toolRegistry, toolText, present } from "./fakes.ts";

// Root doubles as XDG_RUNTIME_DIR. macOS tmpdir() is too long for the 103-byte socket limit.
const root = mkdtempSync("/tmp/pha-");
const stateRoot = join(root, "long-durable-state-" + "x".repeat(140));
const project = join(root, "project");
mkdirSync(project);
const fixtures: { stop(): Promise<unknown[]> }[] = [];
const navigationEvents = [
  { type: "session_before_switch", reason: "new" },
  { type: "session_before_fork", entryId: "", position: "at" },
  { type: "session_before_tree", preparation: { targetId: "", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false }, signal: new AbortController().signal },
] satisfies ExtensionEvent[];
const inertEvents = [{ type: "input", source: "extension", text: "" }, { type: "tool_call", toolCallId: "fixture", toolName: "bash", input: { command: "ln -s ../other/node_modules node_modules" } }, ...navigationEvents, { type: "cache_warming_decision", warmCost: 0, missCost: 0, continuationProbability: 0, action: "warm" }] satisfies ExtensionEvent[];
function fixture({ id = "session-a", mode = "tui", persistent = true, env = {}, fail = false }: { id?: string; mode?: string; persistent?: boolean; env?: Record<string, string | undefined>; fail?: boolean | "report" } = {}) {
  const sessionFile = join(root, `${id}.jsonl`);
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", id }) + "\n");
  const environment = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/exact/default.sock", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1",
    XDG_STATE_HOME: stateRoot, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: join(root, "pi-config"), ...env };
  const hooks = hookRegistry(), tools = toolRegistry(), widgets = new Map<string, unknown>();
  const commands: { command: string; args: string[] }[] = [], notifications: string[] = [];
  let selected = ["read", "bash", "my-selected-tool"], changes = 0, shutdowns = 0;
  const ctx = fakeContext({ mode: "tui", hasUI: mode === "tui" || mode === "rpc", cwd: project, model: fakeModel("fixture", "no-network"),
    modelRegistry: fakeRegistry({ find: (provider, id) => fakeModel(provider, id),
      hasConfiguredAuth: () => true, getProviderAuthStatus: () => ({ configured: true }) }),
    sessionManager: fakeSessions({ getSessionFile: () => persistent ? sessionFile : undefined, getSessionId: () => id }),
    isIdle: () => true, hasPendingMessages: () => false, shutdown() { shutdowns++; },
    ui: fakeUi({ notify(message) { notifications.push(message); }, setWidget(key, value) { widgets.set(key, value); } }) });
  Reflect.set(ctx, "mode", mode);
  const api = fakeApi({
    on: hooks.on, registerTool: tools.register,
    registerCommand() {},
    getAllTools: () => [], getActiveTools: () => selected, setActiveTools(value) { selected = value; changes++; },
    getThinkingLevel: () => "high", setThinkingLevel() {}, appendEntry() {},
    async exec(command, args) {
      commands.push({ command, args });
      assert.equal(command, "env");
      assert.deepEqual(args.slice(0, 6), ["-u", "HERDR_SESSION", "-u", "HERDR_SESSION_NAME", `HERDR_SOCKET_PATH=${environment.HERDR_SOCKET_PATH}`, "herdr"]);
      const op = args.slice(6);
      if (fail === true || (fail === "report" && op[1] === "report-agent")) return { code: 1, killed: false, stderr: "fixture startup fault", stdout: "" };
      if (op[0] === "agent") return { code: 1, killed: false, stderr: "fixture child failure", stdout: "" };
      const pane = { pane_id: op[2], workspace_id: "w1", terminal_id: "terminal-1", tab_id: "w1:t1" };
      const result = op[0] === "tab" ? { root_pane: { ...pane, pane_id: "w1:p-new" } } : { pane };
      return { code: 0, killed: false, stderr: "", stdout: op[1] === "get" || op[0] === "tab" ? JSON.stringify({ result }) : "" };
    },
  });
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
  const emit = (name: Parameters<typeof hooks.emit>[0]) => hooks.emit(name, ctx);
  const instance = { ctx, get config() { return present(config, "startup configuration"); }, emit, tools, widgets, commands, notifications,
    get changes() { return changes; }, get shutdowns() { return shutdowns; },
    identity() { return JSON.parse(readFileSync(join(present(config, "startup configuration").stateDir, "workers", `${present(config, "startup configuration").workerId}.json`), "utf8")); },
    start: () => emit({ type: "session_start", reason: "startup" }), stop: () => emit({ type: "session_shutdown", reason: "quit" }),
  };
  fixtures.push(instance);
  return instance;
}
async function inert(instance: ReturnType<typeof fixture>) {
  await instance.start();
  await instance.emit({ type: "agent_start" });
  await instance.emit({ type: "agent_settled" });
  const event = { type: "before_agent_start" as const, prompt: "hello", systemPrompt: "", systemPromptOptions: { cwd: project, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [] } };
  await instance.emit(event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
  for (const event of inertEvents)
    assert.ok((await instance.emit(event)).every(result => result === undefined));
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
  const b = fixture({ id: "session-b", env: { HERDR_SOCKET_PATH: "/exact/named.sock", HERDR_SESSION: "named" } });
  await a.start(); await b.start();
  assert.equal(a.tools.size, 7);
  const bash = (command: string) => ({ type: "tool_call" as const, toolCallId: "fixture", toolName: "bash", input: { command } });
  const link = bash("ln -s ../other/node_modules node_modules");
  const refusal = [{ block: true, reason: "Refused: this links another checkout's node_modules. Install dependencies in this worktree instead (for example `npm ci`)." }];
  assert.deepEqual(await a.emit(link), refusal, "lead refuses a borrowed dependency directory");
  for (const command of ["npm ci", "ln -s a b", "ln -s ../other/node_modules backup"])
    assert.deepEqual(await a.emit(bash(command)), [undefined], `lead permits ${command}`);
  assert.deepEqual(await a.emit({ type: "tool_call", toolCallId: "fixture", toolName: "read", input: { path: "ln -s ../other/node_modules node_modules" } }), [undefined]);
  assert.ok(a.tools.has("retire_agent"), "ordinary autoload discovers retirement without changing root tool selection");
  assert.equal(a.changes, 0, "root preserves user-selected tools");
  assert.notEqual(a.config.stateDir, b.config.stateDir);
  assert.notEqual(a.identity().socketPath, b.identity().socketPath);
  assert.ok(Buffer.byteLength(a.identity().socketPath) <= 103);
  assert.ok(a.config.stateDir.length > 200);
  assert.deepEqual(readdirSync(project), [], "runtime state never enters project");
  assert.equal(a.config.herdrSession, "", "default server needs no invented session name");
  assert.equal(b.config.herdrSession, "named");
  assert.equal(fixture({ id: "session-legacy", env: { HERDR_SESSION_NAME: "legacy" } }).config.herdrSession, "legacy", "Herdr 0.8 session name still read");
  const endpointScoped = fixture({ env: { HERDR_SOCKET_PATH: "/another/default.sock" } });
  assert.notEqual(endpointScoped.config.stateDir, a.config.stateDir);
  for (const event of navigationEvents)
    assert.deepEqual(await a.emit(event), [undefined]);
  await a.tools.get("update_plan").execute("plan", { plan: [{ step: "exact plan", status: "pending" }] }, undefined, undefined, a.ctx);
  const original = a.identity();
  const child = fixture({ id: "child-session", env: {
    HERDR_PANE_ID: "w1:p-child", DS_HERDR_WORKER_ID: "child", DS_HERDR_PARENT_ID: "lead", DS_HERDR_ROLE: "review",
    DS_HERDR_STATE_DIR: a.config.stateDir, DS_HERDR_SOCKET_DIR: a.config.socketDir, DS_HERDR_SESSION: "", DS_HERDR_WORKSPACE: project,
  } });
  await child.start();
  const childIdentity = child.identity();
  // macOS /tmp is a symlink to /private/tmp: Pi reports the real path while the launch may name the link.
  const linked = join(root, "linked-project");
  symlinkSync(project, linked);
  const linkedChild = fixture({ id: "linked-session", env: {
    HERDR_PANE_ID: "w1:p-linked", DS_HERDR_WORKER_ID: "linked", DS_HERDR_PARENT_ID: "lead", DS_HERDR_ROLE: "explore",
    DS_HERDR_STATE_DIR: a.config.stateDir, DS_HERDR_SOCKET_DIR: a.config.socketDir, DS_HERDR_SESSION: "", DS_HERDR_WORKSPACE: linked,
  } });
  await linkedChild.start();
  assert.deepEqual(linkedChild.notifications, [], "a symlinked workspace is the same directory");
  assert.equal(linkedChild.identity().cwd, linked);
  await linkedChild.stop();
  for (const event of navigationEvents)
    assert.deepEqual(await child.emit(event), [{ cancel: true }], "worker retains assigned conversation history");
  assert.deepEqual(await child.emit(bash("")), [undefined], "review role has no shell ban");
  assert.deepEqual(await child.emit(link), refusal, "Pi worker refuses a borrowed dependency directory");
  for (const command of ["npm ci", "ln -s a b"])
    assert.deepEqual(await child.emit(bash(command)), [undefined], `Pi worker permits ${command}`);
  const duplicate = fixture();
  await duplicate.start();
  assert.match(present(duplicate.notifications[0], "duplicate notification"), /still live/);
  assert.equal(duplicate.tools.size, 0);
  assert.equal(duplicate.shutdowns, 0);
  assert.equal(a.identity().generation, original.generation);
  assert.ok(existsSync(original.socketPath));
  await a.stop();
  assert.deepEqual(await a.emit(link), [undefined], "stopped lead adapter is inert");
  const restored = fixture();
  // Native Pi leaves an empty session unflushed, even though getSessionFile returns its path.
  rmSync(present(restored.ctx.sessionManager.getSessionFile(), "restored session file"));
  await restored.emit({ type: "session_start", reason: "reload" });
  assert.notEqual(restored.identity().generation, original.generation);
  const restoredWidget = present(restored.widgets.get("ds-plan"), "plan widget");
  if (!Array.isArray(restoredWidget)) throw new Error("expected plan widget lines");
  assert.equal(restoredWidget[0], "[ ] exact plan");
  const descendants = await restored.tools.get("list_agents").execute("list", {}, undefined, undefined, restored.ctx);
  const listed = JSON.parse(toolText(descendants));
  assert.equal(listed[0].identity.generation, childIdentity.generation, "root reload preserves live descendants");
  assert.equal(listed[0].kind, "status");
  assert.equal(restored.shutdowns, 0);
  assert.deepEqual(await restored.emit(link), refusal, "empty-history reload keeps one effective guard");
  assert.deepEqual(await restored.emit(bash("npm ci")), [undefined]);
  writeFileSync(present(restored.ctx.sessionManager.getSessionFile(), "restored session file"), JSON.stringify({ type: "session", id: "session-a" }) + "\n");
  await restored.stop();
  // A crashed previous generation must pass death proof, never merely available:false.
  const saved = restored.identity();
  rmSync(join(restored.config.stateDir, "locks", "lead.detached.json"));
  atomicWrite(join(restored.config.stateDir, "workers", "lead.json"), { ...saved, available: true, pidBirth: "dead-generation" });
  const recovered = fixture();
  await recovered.emit({ type: "session_start", reason: "resume" });
  assert.equal(recovered.tools.size, 7);
  assert.notEqual(recovered.identity().generation, saved.generation);
  const status = await request(recovered.identity().socketPath, { kind: "status", generation: recovered.identity().generation,
    callerId: "lead", callerGeneration: recovered.identity().generation });
  assert.equal(status.kind, "status");
  await assert.rejects(recovered.tools.get("spawn_agent").execute("child", { role: "implement", thinking: "medium", task: "new task" }, undefined, undefined, recovered.ctx), /fixture child failure/);
  const created = present(recovered.commands.find(({ args }) => args[6] === "tab"), "tab command").args;
  await assert.rejects(recovered.tools.get("spawn_agent").execute("linked", { role: "explore", thinking: "medium", task: "t", cwd: linked }, undefined, undefined, recovered.ctx), /fixture child failure/);
  const linkedTab = present(recovered.commands.filter(({ args }) => args[6] === "tab").at(-1), "linked tab command").args;
  assert.equal(linkedTab[linkedTab.indexOf("--cwd") + 1], realpathSync(project), "spawn assigns the canonical directory");
  const tabs = recovered.commands.filter(({ args }) => args[6] === "tab").length;
  await assert.rejects(recovered.tools.get("spawn_agent").execute("missing", { role: "explore", thinking: "medium", task: "t", cwd: join(root, "missing") }, undefined, undefined, recovered.ctx), /cwd does not exist/);
  assert.equal(recovered.commands.filter(({ args }) => args[6] === "tab").length, tabs, "a missing cwd is refused before tab creation");
  assert.ok(created.includes(`PI_CODING_AGENT_DIR=${join(root, "pi-config")}`));
  assert.ok(created.includes(`DS_HERDR_SOCKET_DIR=${recovered.config.socketDir}`));
  assert.ok(created.includes("HERDR_SOCKET_PATH=/exact/default.sock"));
  const started = present(recovered.commands.find(({ args }) => args[6] === "agent"), "agent command").args;
  assert.equal(started[started.indexOf("-e") + 1], extensionPath);
  assert.equal(extensionPath, fileURLToPath(new URL("./index.ts", import.meta.url)));
  assert.ok(!started.some(arg => arg.includes("/opt/adapter")));
  assert.equal(started[started.indexOf("--model") + 1], "fixture/no-network");
  // Herdr may type the launch command into a shell still in canonical mode; macOS truncates canonical input at 1024 bytes.
  // Four 200-byte segments exceed the limit whatever the checkout path; each stays under the 255-byte name limit.
  const deep = fixture({ id: "deep-state", env: { XDG_STATE_HOME: join(root, "a".repeat(200), "b".repeat(200), "c".repeat(200), "d".repeat(200)) } });
  await deep.start();
  await assert.rejects(deep.tools.get("spawn_agent").execute("child", { role: "implement", thinking: "medium", task: "t" }, undefined, undefined, deep.ctx), /launch command too long/);
  assert.ok(!deep.commands.some(({ args }) => args[6] === "tab"), "overlong launch refused before tab creation");
  assert.deepEqual(readdirSync(join(deep.config.stateDir, "locks")).filter(name => name.startsWith("launch-")), [], "overlong launch leaves no claim");
  await deep.stop();
  const defaultConfig = fixture({ id: "default-config", env: { HOME: root, PI_CODING_AGENT_DIR: undefined } });
  await defaultConfig.start();
  await assert.rejects(defaultConfig.tools.get("spawn_agent").execute("default-child", { role: "implement", thinking: "medium", task: "new task" }, undefined, undefined, defaultConfig.ctx), /fixture child failure/);
  const defaultLaunch = present(defaultConfig.commands.find(({ args }) => args[6] === "tab"), "default tab command").args;
  assert.ok(defaultLaunch.includes(`PI_CODING_AGENT_DIR=${join(root, ".pi", "agent")}`),
    "unset config uses the lead's effective default, not Herdr server environment");
  const fault = fixture({ id: "fault", fail: true });
  await fault.start();
  assert.match(present(fault.notifications[0], "fault notification"), /disabled.*startup fault/);
  assert.equal(fault.shutdowns, 0);
  assert.equal(fault.changes, 0);
  assert.equal(fault.tools.size, 0);
  assert.deepEqual(await fault.emit({ type: "input", source: "extension", text: "" }), [undefined]);
  assert.deepEqual(await fault.emit(link), [undefined], "faulted lead adapter is inert");
  await child.stop();
  assert.deepEqual(await child.emit(link), [{ block: true, reason: "Runtime shutting down" }], "shutdown takes precedence over link refusal");
  const guidelines = { type: "before_agent_start" as const, prompt: "", systemPrompt: "", systemPromptOptions: { cwd: project, selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [] } };
  await fault.emit(guidelines);
  assert.deepEqual(guidelines.systemPromptOptions.promptGuidelines, []);
  const reportFault = fixture({ id: "report-fault", fail: "report" });
  await reportFault.start();
  assert.equal(reportFault.shutdowns, 0);
  assert.equal(reportFault.tools.size, 0);
  assert.equal(reportFault.identity().available, false);
  assert.equal(existsSync(reportFault.identity().socketPath), false, "post-claim startup failure closes its socket");
  assert.equal(existsSync(join(reportFault.config.stateDir, "locks", "lead")), false);
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
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
  for (const mode of [undefined, "rpc", "print", "json"] as const) {
    const errors: ExtensionError[] = [];
    const { session } = await createAgentSession({ cwd: project, agentDir, resourceLoader: loader, modelRuntime,
      settingsManager, tools: ["read"], sessionManager: SessionManager.create(project, join(root, "sdk-sessions")) });
    try {
      await session.bindExtensions({ ...(mode ? { mode } : {}), onError: error => { errors.push(error); } });
      assert.deepEqual(errors, []);
      assert.deepEqual(session.getActiveToolNames(), ["read"], "real headless binding preserves tools");
      assert.ok(!session.getAllTools().some(tool => tool.name === "spawn_agent"));
    } finally { session.dispose(); }
    await loader.reload();
  }
  const unsafe = join(root, "unsafe"); mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => privateDirectory(unsafe), /private/);
  process.stdout.write("PASS automatic startup, inert modes, isolation, short sockets, endpoint routing, portable launch, duplicate refusal, symlinked and missing workspaces, clean reload, dead-root recovery, real Pi package discovery and headless SDK binding. No native Herdr/model calls.\n");
} finally {
  for (const fixture of fixtures.reverse()) await fixture.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
