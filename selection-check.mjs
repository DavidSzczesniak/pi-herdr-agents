// Actual Pi catalog/capabilities; native TUI/Herdr launch and provider turns are stubbed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { clampThinkingLevel, InMemoryCredentialStore, getSupportedThinkingLevels, validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import adapter from "./index.ts";
import { atomicWrite, parseIdentity, request } from "./protocol.ts";
import { recordedThinking, selectWorker } from "./runtime.ts";
import { socketDirectory } from "./startup.ts";

const root = mkdtempSync(join(tmpdir(), "piha-selection-"));
const originalEnv = { ...process.env };
const instances = [];
const commands = [];
const catalog = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(root, "models.json"),
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
const reasoning = catalog.getModel("openai", "gpt-5.4");
const plain = catalog.getModel("openai", "gpt-4o");
assert.ok(reasoning && plain);
const models = [reasoning, plain];
const key = model => ({ provider: model.provider, id: model.id });
const pane = id => ({ pane_id: id, terminal_id: `term-${id}`, workspace_id: "w1", tab_id: `tab-${id}` });
const readIdentity = id => JSON.parse(readFileSync(join(root, "workers", `${id}.json`)));
const self = (identity, operation) => request(identity.socketPath, { callerId: identity.workerId, callerGeneration: identity.generation,
  generation: identity.generation, ...operation });
let created;
let onPaneGet;
const selectionsAtSend = [];
let nextChildModel;
let nextChildThinking;
function fixture({ id = "lead", parent = "", role = "lead", model = reasoning, thinking = "high", auth = true,
  sessionFile = join(root, `${id}.jsonl`), sessionId = `session-${id}`, launchId = "", restart = "" } = {}) {
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fixture/selection.sock", HERDR_SESSION_NAME: "", HERDR_PANE_ID: id,
    HERDR_WORKSPACE_ID: "w1", DS_HERDR_STATE_DIR: root, DS_HERDR_WORKER_ID: id, DS_HERDR_PARENT_ID: parent,
    DS_HERDR_ROLE: role, DS_HERDR_SESSION: "", DS_HERDR_WORKSPACE: root, DS_HERDR_LAUNCH_ID: launchId,
    DS_HERDR_RESTART_GENERATION: restart });
  delete process.env.DS_HERDR_SOCKET_DIR;
  const hooks = new Map(), tools = new Map();
  let level = clampThinkingLevel(model, thinking), idle = true, sends = 0, error;
  const ctx = { cwd: root, mode: "tui", hasUI: true, model,
    get thinkingLevel() { return level; },
    modelRegistry: { find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
      hasConfiguredAuth: () => auth, getProviderAuthStatus: () => ({ configured: auth }) },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId },
    isIdle: () => idle, hasPendingMessages: () => false, shutdown() {},
    ui: { notify(message) { error = message; }, setWidget() {} } };
  const emit = async (name, event = {}) => { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); };
  const api = { on(name, fn) { hooks.set(name, [...hooks.get(name) || [], fn]); }, registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {}, getActiveTools: () => ["read", "bash"], setActiveTools() {},
    getThinkingLevel: () => level, setThinkingLevel(value) { level = clampThinkingLevel(ctx.model, value); },
    async exec(_command, argv) {
      const args = argv.slice(argv.indexOf("herdr") + 1); commands.push(args);
      if (args[0] === "pane" && args[1] === "get") await onPaneGet?.(args);
      if (args[0] === "tab") {
        created = Object.fromEntries(args.filter(arg => arg.startsWith("DS_HERDR_")).map(arg => { const i = arg.indexOf("="); return [arg.slice(0, i), arg.slice(i + 1)]; }));
        return { code: 0, stdout: JSON.stringify({ result: { root_pane: pane(created.DS_HERDR_WORKER_ID) } }) };
      }
      if (args[0] === "agent") {
        const selected = args[args.indexOf("--model") + 1];
        const childModel = nextChildModel ?? models.find(m => `${m.provider}/${m.id}` === selected);
        const childThinking = nextChildThinking ?? args[args.indexOf("--thinking") + 1];
        nextChildModel = undefined; nextChildThinking = undefined;
        const path = args[args.indexOf("--session") + 1];
        const savedId = readFileSync(path, "utf8").trim() ? JSON.parse(readFileSync(path, "utf8").split("\n")[0]).id : `session-${created.DS_HERDR_WORKER_ID}`;
        const child = fixture({ id: created.DS_HERDR_WORKER_ID, parent: created.DS_HERDR_PARENT_ID, role: created.DS_HERDR_ROLE,
          model: childModel, thinking: childThinking, sessionFile: path, sessionId: savedId,
          launchId: created.DS_HERDR_LAUNCH_ID, restart: created.DS_HERDR_RESTART_GENERATION });
        await child.start();
        return { code: 0, stdout: "{}" };
      }
      return { code: 0, stdout: args[1] === "get" ? JSON.stringify({ result: { pane: pane(args[2]) } }) : "" };
    },
    sendUserMessage(text) { selectionsAtSend.push({ id, model: key(ctx.model), thinking: level }); sends++;
      if (instance.onSend) return instance.onSend(text);
      void (async () => {
      await emit("input", { source: "extension", text });
      await emit("before_agent_start", { prompt: text, systemPromptOptions: { promptGuidelines: [] } });
      idle = false; await emit("agent_start");
    })(); },
  };
  adapter(api);
  const instance = { id, ctx, tools, sessionFile, emit, onSend: undefined,
    emitNow(name, event = {}) { return Promise.all((hooks.get(name) ?? []).map(fn => fn(event, ctx))); },
    get sends() { return sends; }, get level() { return level; },
    async start(reason = "startup") { await emit("session_start", { reason }); if (error) throw Error(error); return readIdentity(id); },
    async stop() { await emit("session_shutdown"); },
    async settle() { idle = true; await emit("agent_before_settle", { outcome: "completed" }); await emit("agent_settled"); },
    async changeThinking(value) { level = clampThinkingLevel(ctx.model, value); await emit("thinking_level_select", { level }); },
    async changeModel(value) { ctx.model = value; level = clampThinkingLevel(value, level); await emit("thinking_level_select", { level }); await emit("model_select", { model: value, source: "set" }); },
    async tool(name, params) {
      const tool = tools.get(name);
      const validated = validateToolArguments(tool, { type: "toolCall", id: "test", name, arguments: params });
      return JSON.parse((await tool.execute("test", validated, undefined, undefined, ctx)).content[0].text);
    },
  };
  instances.push(instance); return instance;
}
const childFor = receipt => instances.findLast(instance => instance.id === receipt.workerId);
try {
  const lead = fixture(); await lead.start();
  // Review repro: native changes after the caller's first status snapshot, before submit.
  for (const mode of ["followup", "launch"]) {
    for (const change of ["thinking", "model"]) {
      let child;
      if (mode === "followup") {
        child = childFor(await lead.tool("spawn_agent", { role: "review", thinking: "low", task: "initial" }));
        await child.settle();
      }
      let paneChecks = 0;
      onPaneGet = async args => {
        const target = child ?? instances.findLast(instance => instance.id === created?.DS_HERDR_WORKER_ID);
        // Launch also has a child-startup pane check before its two caller checks.
        if (args[2] !== target?.id || ++paneChecks !== (mode === "launch" ? 3 : 2)) return;
        if (change === "thinking") await target.changeThinking("high");
        else await target.changeModel(plain);
      };
      const receipt = mode === "launch"
        ? await lead.tool("spawn_agent", { role: "review", thinking: "low", task: "launch race" })
        : await lead.tool("followup_task", { agent_id: child.id, task: "followup race" });
      onPaneGet = undefined;
      child = childFor(receipt);
      const atSend = selectionsAtSend.at(-1);
      assert.equal(receipt.kind, "accepted");
      assert.equal(atSend.thinking, change === "thinking" ? "high" : "off");
      assert.deepEqual(atSend.model, key(change === "model" ? plain : reasoning));
      assert.equal(receipt.identity.thinking, atSend.thinking, `${mode} ${change}: receipt must report the task's selection, not the first status snapshot`);
      assert.deepEqual(receipt.identity.model, atSend.model);
      const expected = { boundary: "agent_start", model: atSend.model, thinking: atSend.thinking };
      assert.deepEqual(receipt.selection, expected);
      const path = join(root, "tasks", child.id, `${receipt.submissionId}.json`);
      assert.deepEqual(JSON.parse(readFileSync(path)).selection, expected);
      // A retry's later native start must not relabel the first task observation.
      await child.changeModel(reasoning); await child.changeThinking("medium");
      await child.emit("agent_start");
      assert.deepEqual(JSON.parse(readFileSync(path)).selection, expected);
      await child.settle();
      const settled = await lead.tool("wait_agent", { agent_id: child.id, submission_id: receipt.submissionId, timeout_ms: 120000 });
      assert.deepEqual(settled.selection, expected);
      assert.deepEqual(receipt.selection, expected);
      // Legacy historical task records are not attributed using today's worker identity.
      const legacyTask = JSON.parse(readFileSync(path)); delete legacyTask.selection;
      atomicWrite(path, legacyTask);
      const historical = await lead.tool("wait_agent", { agent_id: child.id, submission_id: receipt.submissionId, timeout_ms: 120000 });
      assert.equal(historical.selection, null);
      process.stdout.write(`PASS receipt race ${mode}/${change}: first correlated start retained through later native change, retry and settlement\n`);
    }
  }
  let launchPaneChecks = 0;
  onPaneGet = args => {
    const child = instances.findLast(instance => instance.id === created?.DS_HERDR_WORKER_ID);
    if (args[2] === child?.id && ++launchPaneChecks === 3) child.onSend = () => {};
  };
  const ambiguousLaunch = await lead.tool("spawn_agent", { role: "review", thinking: "low", task: "unobserved launch" });
  onPaneGet = undefined;
  assert.equal(ambiguousLaunch.kind, "ambiguous"); assert.equal(ambiguousLaunch.selection, null);
  assert.equal(ambiguousLaunch.identity.model, null); assert.equal(ambiguousLaunch.identity.thinking, null);
  assert.equal(childFor(ambiguousLaunch).sends, 1);
  await childFor(ambiguousLaunch).stop();

  const boundaryChild = fixture({ id: "boundary", parent: "lead", role: "review", thinking: "low" });
  await boundaryChild.start();
  // The task can change selection after sendUserMessage but before the correlated start.
  for (const change of ["thinking", "model"]) {
    await boundaryChild.changeThinking("low");
    boundaryChild.onSend = text => { void (async () => {
      await boundaryChild.emit("input", { source: "extension", text });
      await boundaryChild.emit("before_agent_start", { prompt: text, systemPromptOptions: { promptGuidelines: [] } });
      if (change === "thinking") await boundaryChild.changeThinking("high");
      else await boundaryChild.changeModel(plain);
      await boundaryChild.emit("agent_start");
    })(); };
    const boundaryReceipt = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "start boundary" });
    assert.equal(selectionsAtSend.at(-1).thinking, "low");
    assert.equal(boundaryReceipt.identity.thinking, change === "thinking" ? "high" : "off", "observe at worker start, not caller status or send");
    assert.deepEqual(boundaryReceipt.identity.model, key(change === "thinking" ? reasoning : plain));
    await boundaryChild.settle();
  }
  await boundaryChild.changeModel(reasoning); await boundaryChild.changeThinking("high");

  // Synchronous fixture settlement and a later model change before the submit handler reads its task.
  boundaryChild.onSend = text => {
    void boundaryChild.emitNow("input", { source: "extension", text });
    void boundaryChild.emitNow("before_agent_start", { prompt: text, systemPromptOptions: { promptGuidelines: [] } });
    void boundaryChild.emitNow("agent_start");
    void boundaryChild.emitNow("message_end", { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100000) }], stopReason: "stop" } });
    void boundaryChild.emitNow("agent_before_settle", { outcome: "completed" });
    void boundaryChild.emitNow("agent_settled");
    void boundaryChild.changeModel(plain);
  };
  const fast = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "fast settlement" });
  assert.equal(fast.kind, "settled");
  assert.ok(Buffer.byteLength(JSON.stringify(fast)) < 50000);
  assert.equal(readFileSync(fast.artifactPath, "utf8").length, 100000);
  const fastRaw = await self(readIdentity(boundaryChild.id), { kind: "wait", submissionId: fast.submissionId, timeoutMs: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(fastRaw)) <= 45000);
  assert.deepEqual(fast.selection, { boundary: "agent_start", model: key(reasoning), thinking: "high" });
  assert.deepEqual(fast.identity.model, key(reasoning)); assert.equal(fast.identity.thinking, "high");
  assert.deepEqual(readIdentity(boundaryChild.id).model, key(plain));

  // An unrelated start cannot supply selection evidence for a reserved submission.
  boundaryChild.onSend = () => { void boundaryChild.emit("agent_start"); };
  const ambiguous = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "unobserved task" });
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal(ambiguous.selection, null); assert.equal(ambiguous.identity.model, null); assert.equal(ambiguous.identity.thinking, null);
  const beforeLateStart = boundaryChild.sends;
  const busy = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "busy is still fenced" });
  assert.equal(busy.kind, "ambiguous"); assert.match(busy.reason, /busy/);
  assert.equal(busy.selection, null); assert.equal(boundaryChild.sends, beforeLateStart);
  const pendingPath = join(root, "tasks", boundaryChild.id, `${ambiguous.submissionId}.json`);
  const pending = JSON.parse(readFileSync(pendingPath));
  assert.equal(pending.selection, null);
  const pendingText = `[ds-task ${pending.nonce}]\n${pending.task}`;
  await boundaryChild.emit("input", { source: "extension", text: pendingText });
  await boundaryChild.emit("before_agent_start", { prompt: pendingText, systemPromptOptions: { promptGuidelines: [] } });
  await boundaryChild.emit("agent_start");
  assert.equal(boundaryChild.sends, beforeLateStart, "late observation does not replay submission");
  assert.equal(JSON.parse(readFileSync(pendingPath)).selection.thinking, "off");
  assert.equal(ambiguous.selection, null, "earlier ambiguous receipt remains unknown");
  await boundaryChild.settle();
  await boundaryChild.stop();

  // A legacy endpoint can return current identity but cannot attest this task's selection.
  const legacyEndpointIdentity = { ...readIdentity(boundaryChild.id), available: true };
  delete legacyEndpointIdentity.thinking;
  atomicWrite(join(root, "workers", `${boundaryChild.id}.json`), legacyEndpointIdentity);
  let replyMode = "legacy";
  const legacyServer = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", chunk => {
      input += chunk; if (!input.includes("\n")) return;
      const message = JSON.parse(input.split("\n")[0]);
      const result = message.kind === "status" ? { kind: "status", identity: legacyEndpointIdentity, active: null, idle: true }
        : { kind: "accepted", workerId: boundaryChild.id, generation: legacyEndpointIdentity.generation,
          submissionId: replyMode === "mismatch" ? "different-task" : message.submissionId, evidence: "agent_start",
          ...(replyMode === "legacy" ? {} : { selection: { boundary: "agent_start", model: key(plain), thinking: replyMode === "invalid" ? "invented" : "off" } }) };
      if (replyMode === "disconnect" && message.kind === "submit") socket.destroy();
      else socket.end(JSON.stringify({ ok: true, result }) + "\n");
    });
  });
  await new Promise(resolve => legacyServer.listen(legacyEndpointIdentity.socketPath, resolve));
  try {
    for (replyMode of ["legacy", "mismatch", "invalid", "disconnect"]) {
      const result = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: replyMode });
      assert.equal(result.kind, replyMode === "legacy" ? "accepted" : "ambiguous");
      assert.equal(result.selection, null); assert.equal(result.identity.model, null); assert.equal(result.identity.thinking, null);
      assert.notEqual(result.submissionId, "different-task");
    }
  } finally { await new Promise(resolve => legacyServer.close(resolve)); }
  atomicWrite(join(root, "workers", `${boundaryChild.id}.json`), { ...legacyEndpointIdentity, available: false });
  process.stdout.write("PASS task selection boundary, fast settlement, unknown legacy/history/ambiguous/invalid/disconnect, correlation mismatch and no replay\n");
  assert.ok(lead.tools.get("spawn_agent").parameters.properties.model, "spawn exposes model override");
  assert.ok(lead.tools.get("spawn_agent").parameters.required.includes("thinking"), "spawn requires thinking");
  assert.ok(!lead.tools.get("spawn_agent").parameters.required.includes("model"), "model remains optional");
  for (const role of ["explore", "implement", "review", "judgment"]) {
    for (const thinking of ["low", "high"]) {
      const receipt = await lead.tool("spawn_agent", { role, thinking, task: "brief" });
      assert.equal(receipt.kind, "accepted");
      assert.deepEqual(receipt.identity.model, key(reasoning));
      assert.equal(receipt.identity.thinking, thinking, "level is independent of role");
      assert.equal(childFor(receipt).level, thinking);
      await childFor(receipt).settle();
    }
  }
  const overridden = await lead.tool("spawn_agent", { role: "explore", task: "brief", thinking: "high" });
  const child = childFor(overridden);
  assert.equal(child.level, "high", "worker startup must not reset explicit thinking to role default");
  await child.settle();
  const selected = await child.tool("spawn_agent", { role: "judgment", task: "brief", model: key(plain), thinking: "off" });
  assert.deepEqual(selected.identity.model, key(plain), "explicit model replaces caller model");
  assert.equal(selected.identity.thinking, "off");
  const nested = await childFor(selected).tool("spawn_agent", { role: "review", task: "brief", thinking: "off" });
  assert.deepEqual(nested.identity.model, key(plain), "nested spawn inherits immediate caller, not lead");
  assert.equal(nested.identity.thinking, "off");
  const explicitOff = await lead.tool("spawn_agent", { role: "judgment", task: "brief", model: key(plain), thinking: "off" });
  assert.equal(explicitOff.identity.thinking, "off");

  const snapshot = () => JSON.stringify({ commands: commands.length, locks: readdirSync(join(root, "locks")), sessions: readdirSync(join(root, "sessions")), operations: readdirSync(join(root, "operations")) });
  const before = snapshot();
  for (const role of ["explore", "implement", "review", "judgment"]) {
    await assert.rejects(lead.tool("spawn_agent", { role, task: "brief" }), /Validation failed[\s\S]*thinking/);
    assert.equal(snapshot(), before, "missing thinking is rejected by Pi's schema validator before allocation");
  }
  for (const thinking of [undefined, null, "", "invented", 42]) {
    await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", thinking }), /Validation failed[\s\S]*thinking/);
  }
  await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", model: key(plain), thinking: "high" }), /Unsupported thinking.*off/);
  await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", model: { provider: "unknown", id: "absent" }, thinking: "high" }), /Unknown model/);
  const unsupported = ["max", "xhigh", "minimal"].find(level => !getSupportedThinkingLevels(reasoning).includes(level));
  assert.ok(unsupported);
  await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", thinking: unsupported }), /Unsupported thinking/);
  assert.equal(snapshot(), before, "invalid choices allocate no claim, receipt, session or tab");
  const noauth = fixture({ id: "noauth", parent: "lead", role: "review", auth: false }); await noauth.start();
  const beforeAuth = snapshot();
  await assert.rejects(noauth.tool("spawn_agent", { role: "review", task: "brief", thinking: "medium" }), /authentication/);
  assert.equal(snapshot(), beforeAuth, "missing auth rejected before allocation");
  const rejected = await lead.tool("followup_task", { agent_id: noauth.id, task: "preflight rejection" });
  assert.equal(rejected.kind, "unavailable"); assert.equal(noauth.sends, 0);
  assert.equal(rejected.selection, null); assert.equal(rejected.identity.model, null); assert.equal(rejected.identity.thinking, null);
  await noauth.stop();
  const legacyLive = readIdentity("noauth"); delete legacyLive.thinking;
  atomicWrite(join(root, "workers", "noauth.json"), legacyLive);
  const migrated = fixture({ id: "noauth", parent: "lead", role: "review", thinking: "low" });
  assert.equal((await migrated.start("reload")).thinking, "low", "legacy same-process reload captures native effort, not role default");
  const migratedReceipt = await lead.tool("followup_task", { agent_id: "noauth", task: "new legacy task" });
  assert.equal(migratedReceipt.identity.thinking, "low"); await migrated.settle(); await migrated.stop();

  await child.changeThinking("low");
  let followup = await lead.tool("followup_task", { agent_id: child.id, task: "new task" });
  assert.equal(followup.identity.thinking, "low"); await child.settle();
  await child.changeModel(plain);
  assert.equal(readIdentity(child.id).thinking, "off");
  assert.deepEqual(readIdentity(child.id).model, key(plain));
  const listed = await lead.tool("list_agents", {});
  assert.equal(listed.find(row => row.identity.workerId === child.id).identity.thinking, "off");
  await child.stop();
  assert.equal(readFileSync(child.sessionFile, "utf8"), "", "empty-history fixture has no native entries");
  rmSync(child.sessionFile);
  const reload = fixture({ id: child.id, parent: "lead", role: "explore", model: plain, thinking: "off", sessionFile: child.sessionFile, launchId: "released-initial-claim" });
  const reloaded = await reload.start("reload");
  assert.equal(reloaded.thinking, "off"); assert.equal(reload.sends, 0);
  await reload.stop();
  writeFileSync(child.sessionFile, JSON.stringify({ type: "session", id: reloaded.piSessionId }) + "\n");
  atomicWrite(join(root, "workers", `${child.id}.json`), { ...readIdentity(child.id), pidBirth: "dead-process" });
  followup = await lead.tool("followup_task", { agent_id: child.id, task: "cold new task" });
  assert.equal(followup.identity.thinking, "off"); assert.deepEqual(followup.identity.model, key(plain));
  assert.equal(followup.identity.piSessionId, reloaded.piSessionId);
  assert.notEqual(followup.generation, reloaded.generation);
  assert.equal(childFor(followup).sends, 1, "cold recovery submits only new task");
  await childFor(followup).settle(); await childFor(followup).stop();

  const legacy = readIdentity(child.id); delete legacy.thinking;
  atomicWrite(join(root, "workers", `${child.id}.json`), { ...legacy, pidBirth: "dead-process" });
  const legacyBefore = snapshot();
  await assert.rejects(lead.tool("followup_task", { agent_id: child.id, task: "do not guess effort" }), /thinking.*unknown/i);
  assert.equal(snapshot(), legacyBefore);
  const legacyRows = await lead.tool("list_agents", {});
  assert.equal(legacyRows.find(row => row.identity.workerId === child.id).identity.thinking, null);
  assert.throws(() => parseIdentity({ ...legacy, thinking: "invented" }), /Invalid/);
  // Legacy cold recovery uses native branch evidence, never buildSessionContext's default off.
  const legacyNative = SessionManager.inMemory(root, { id: legacy.piSessionId });
  legacyNative.appendModelChange(plain.provider, plain.id);
  const branch = legacyNative.appendThinkingLevelChange("off");
  legacyNative.appendThinkingLevelChange("high");
  legacyNative.branch(branch);
  legacyNative.appendCustomEntry("branch-proof", {});
  const legacyContents = [legacyNative.getHeader(), ...legacyNative.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(child.sessionFile, legacyContents);
  const legacyReceipt = await lead.tool("followup_task", { agent_id: child.id, task: "legacy new task" });
  assert.equal(legacyReceipt.identity.thinking, "off", "restore latest native branch, not abandoned high entry");
  assert.equal(readFileSync(child.sessionFile, "utf8"), legacyContents, "legacy lookup never opens a native writer");
  await childFor(legacyReceipt).settle(); await childFor(legacyReceipt).stop();
  writeFileSync(child.sessionFile, legacyContents + "{broken\n");
  assert.throws(() => recordedThinking(parseIdentity(legacy)), /Malformed native history/);
  writeFileSync(child.sessionFile, legacyContents);

  // Pi's sparse level map determines explicit acceptance and rejection, including holes.
  const sparse = { ...reasoning, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } };
  const sparseCtx = { ...lead.ctx, modelRegistry: { ...lead.ctx.modelRegistry, find: () => sparse } };
  assert.throws(() => selectWorker(sparseCtx, { model: key(sparse), thinking: "off" }), /supported: high, max/);
  assert.equal(selectWorker(sparseCtx, { model: key(sparse), thinking: "high" }).thinking, "high");
  assert.equal(selectWorker(sparseCtx, { model: key(sparse), thinking: "max" }).thinking, "max");

  // Real SDK session events, model clamping, and reload. No prompt or provider request.
  const agentDir = join(root, "sdk-config");
  const settingsManager = SettingsManager.inMemory();
  const errors = [], renderedPrompts = [];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => adapter({ ...pi, exec: async (_command, args) => {
      const op = args.slice(args.indexOf("herdr") + 1);
      return { code: 0, killed: false, stderr: "", stdout: op[1] === "get" ? JSON.stringify({ result: { pane: pane(op[2]) } }) : "" };
    } }), pi => pi.on("before_agent_start", event => { renderedPrompts.push(event.systemPrompt); })] });
  Object.assign(process.env, { DS_HERDR_WORKER_ID: "sdk-worker", DS_HERDR_PARENT_ID: "lead", DS_HERDR_ROLE: "review",
    HERDR_PANE_ID: "sdk-worker", DS_HERDR_LAUNCH_ID: "", DS_HERDR_RESTART_GENERATION: "" });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  // A test-only runtime override, never a credential file or provider call.
  await catalog.setRuntimeApiKey("openai", "fixture-not-a-real-key");
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: catalog, model: reasoning, thinkingLevel: "high", sessionManager: SessionManager.create(root, join(root, "sdk-sessions")) });
  try {
    await session.bindExtensions({ mode: "tui", onError: error => errors.push(error) });
    assert.deepEqual(errors, []);
    assert.equal(readIdentity("sdk-worker").thinking, "high", "native SDK startup retains selected effort");
    // A SYSTEM.md custom prompt drops Pi's prompt guidelines; the role brief must still render.
    await session.extensionRunner.emitBeforeAgentStart("probe", undefined, { cwd: root, customPrompt: "CUSTOM PROMPT" });
    assert.match(renderedPrompts.at(-1), /^CUSTOM PROMPT[\s\S]*Role: review\. /, "role brief survives a custom system prompt");
    session.setThinkingLevel("low");
    assert.equal(readIdentity("sdk-worker").thinking, "low", "native thinking event persists before any status poll or await");
    await session.setModel(plain);
    assert.deepEqual(readIdentity("sdk-worker").model, key(plain));
    assert.equal(readIdentity("sdk-worker").thinking, "off", "native model-change clamp persists paired selection");
    assert.equal(existsSync(session.sessionFile), false, "Pi has not flushed empty session history");
    const beforeReload = readIdentity("sdk-worker");
    await session.reload();
    assert.deepEqual(errors, []);
    const afterReload = readIdentity("sdk-worker");
    assert.notEqual(afterReload.generation, beforeReload.generation);
    assert.equal(afterReload.piSessionId, beforeReload.piSessionId);
    assert.deepEqual(afterReload.model, key(plain)); assert.equal(afterReload.thinking, "off");
  } finally {
    // Dispose alone does not emit native session_shutdown. Reload once with no extensions to detach.
    Object.assign(process.env, { HERDR_ENV: "0" });
    await session.reload(); session.dispose();
    Object.assign(process.env, { HERDR_ENV: "1" });
  }

  const nativeSaved = readIdentity("sdk-worker");
  writeFileSync(nativeSaved.piSessionPath, JSON.stringify({ type: "session", id: nativeSaved.piSessionId }) + "\n");
  atomicWrite(join(root, "workers", "sdk-worker.json"), { ...nativeSaved, pidBirth: "dead-sdk-process" });
  const sdkCold = await lead.tool("followup_task", { agent_id: "sdk-worker", task: "new task after native selection changes" });
  assert.deepEqual(sdkCold.identity.model, key(plain)); assert.equal(sdkCold.identity.thinking, "off");
  await childFor(sdkCold).settle(); await childFor(sdkCold).stop();

  nextChildThinking = "low";
  await assert.rejects(lead.tool("spawn_agent", { role: "judgment", task: "brief", thinking: "high" }), /thinking mismatch/);
  const mismatchLaunch = commands.findLast(args => args[0] === "agent");
  const mismatchId = mismatchLaunch[2].slice(0, -9);
  assert.ok(existsSync(join(root, "locks", `launch-${mismatchId}`, "claim.json")), "unknown child identity keeps launch fence");
  assert.equal(lead.level, "high", "lead effort unchanged");
  process.stdout.write("PASS worker selection: real Pi catalog and SDK events/reload; required thinking/optional model, role-independent levels, schema and pre-allocation rejection, nested inheritance, native-change persistence, empty reload, cold continuation, legacy recovery/refusal, thinking fence. Herdr and provider turns stubbed.\n");
} finally {
  for (const instance of instances.reverse()) await instance.stop().catch(() => {});
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  rmSync(socketDirectory(root, originalEnv.XDG_RUNTIME_DIR || "/tmp"), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
