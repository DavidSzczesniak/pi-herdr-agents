import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { clampThinkingLevel, InMemoryCredentialStore, getSupportedThinkingLevels, validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import adapter from "./index.ts";
import { atomicWrite, parseIdentity, request } from "./protocol.ts";
import { recordedThinking, selectWorker } from "./runtime.ts";
import { socketDirectory } from "./startup.ts";
import { fakeApi, fakeContext, fakeRegistry, fakeSessions, fakeUi, hookRegistry, toolRegistry, present, toolText, installFixtureEnvironment, fakePane as pane, beforeAgentStart, completedSettle, herdrArgs, herdrResult, execOk, replaceEnvironment } from "./fakes.ts";
import type { ExtensionEvent, ExtensionError } from "@earendil-works/pi-coding-agent";
import type { Model, Api, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Request } from "./protocol.ts";
import { test } from "vitest";
import { finishCleanup } from "./test-support/cleanup.ts";
import { ownTestCleanup } from "./test-support/ownership.ts";

async function selectionFixture(root: string) {
  type SelectionFixture = { id: string; ctx: ReturnType<typeof fakeContext>; tools: ReturnType<typeof toolRegistry>; sessionFile: string;
    emit(event: ExtensionEvent): Promise<unknown[]>; emitNow(event: ExtensionEvent): Promise<unknown[]>; onSend: ((text: string) => void) | undefined;
    readonly sends: number; readonly level: ModelThinkingLevel; start(reason?: "startup" | "reload"): Promise<ReturnType<typeof readIdentity>>;
    stop(): Promise<void>; settle(): Promise<void>; changeThinking(value: ModelThinkingLevel): Promise<void>; changeModel(value: Model<Api>): Promise<void>;
    tool(name: string, params: Record<string, ReturnType<typeof JSON.parse>>): Promise<ReturnType<typeof JSON.parse>>; };
  const instances: SelectionFixture[] = [];
  const commands: string[][] = [];
  const catalog = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
  const reasoning = catalog.getModel("openai", "gpt-5.4");
  const plain = catalog.getModel("openai", "gpt-4o");
  assert.ok(reasoning && plain);
  const models = [reasoning, plain];
  const thinkingLevel = (value: string): ModelThinkingLevel => {
    switch (value) {
      case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max": return value;
      default: throw new Error(`invalid child thinking: ${value}`);
    }
  };
  const key = (model: Model<Api>) => ({ provider: model.provider, id: model.id });
  const readIdentity = (id: string) => JSON.parse(readFileSync(join(root, "workers", `${id}.json`), "utf8"));
  type OwnRequest = Request extends infer R ? R extends Request ? Omit<R, "callerId" | "callerGeneration" | "generation"> : never : never;
  const self = (identity: { socketPath: string; workerId: string; generation: string }, operation: OwnRequest) => request(identity.socketPath, { callerId: identity.workerId, callerGeneration: identity.generation,
    generation: identity.generation, ...operation });
  let created: Record<string, string> | undefined;
  let onPaneGet: ((args: string[]) => Promise<void> | void) | undefined;
  const selectionsAtSend: { id: string; model: { provider: string; id: string }; thinking: ModelThinkingLevel }[] = [];
  let nextChildModel: Model<Api> | undefined;
  let nextChildThinking: ModelThinkingLevel | undefined;
  function fixture(options: { id?: string; parent?: string; role?: string; model?: Model<Api>; thinking?: ModelThinkingLevel; auth?: boolean; sessionFile?: string; sessionId?: string; launchId?: string; restart?: string } = {}): SelectionFixture {
    const { id = "lead", parent = "", role = "lead", model = reasoning, thinking = "high", auth = true,
      sessionFile = join(root, `${id}.jsonl`), sessionId = `session-${id}`, launchId = "", restart = "" } = options;
    installFixtureEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fixture/selection.sock", HERDR_SESSION: "", HERDR_SESSION_NAME: undefined, HERDR_PANE_ID: id,
      XDG_RUNTIME_DIR: root, HERDR_WORKSPACE_ID: "w1", DS_HERDR_STATE_DIR: root, DS_HERDR_WORKER_ID: id, DS_HERDR_PARENT_ID: parent,
      DS_HERDR_ROLE: role, DS_HERDR_SESSION: "", DS_HERDR_WORKSPACE: root, DS_HERDR_LAUNCH_ID: launchId,
      DS_HERDR_RESTART_GENERATION: restart });
    const hooks = hookRegistry(), tools = toolRegistry();
    let level = clampThinkingLevel(present(model, "selected model"), thinking), idle = true, sends = 0;
    let error: string | undefined;
    const ctx = fakeContext({ cwd: root, mode: "tui", hasUI: true, model, signal: undefined,
      get thinkingLevel() { return level; },
      modelRegistry: fakeRegistry({ find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
        hasConfiguredAuth: () => auth, getProviderAuthStatus: () => ({ configured: auth }) }),
      sessionManager: fakeSessions({ getSessionFile: () => sessionFile, getSessionId: () => sessionId }),
      isIdle: () => idle, hasPendingMessages: () => false, shutdown() {},
      ui: fakeUi({ notify(message) { error = message; }, setWidget() {} }) });
    const emit = (event: ExtensionEvent) => hooks.emit(event, ctx);
    const api = fakeApi({ on: hooks.on, registerTool: tools.register,
      registerCommand() {}, getActiveTools: () => ["read", "bash"], setActiveTools() {},
      getThinkingLevel: () => level, setThinkingLevel(value) { level = clampThinkingLevel(present(ctx.model, "selected model"), value); },
      async exec(_command, argv) {
        const args = herdrArgs(argv); commands.push(args);
        if (args[0] === "pane" && args[1] === "get") await onPaneGet?.(args);
        if (args[0] === "tab") {
          created = Object.fromEntries(args.filter(arg => arg.startsWith("DS_HERDR_")).map(arg => { const i = arg.indexOf("="); return [arg.slice(0, i), arg.slice(i + 1)]; }));
          return herdrResult({ root_pane: pane(present(present(created, "tab environment").DS_HERDR_WORKER_ID, "worker id")) });
        }
        if (args[0] === "agent") {
          const selected = present(args[args.indexOf("--model") + 1], "child model");
          const childModel = nextChildModel ?? models.find(m => `${m.provider}/${m.id}` === selected);
          const childThinking = nextChildThinking ?? present(args[args.indexOf("--thinking") + 1], "child thinking");
          nextChildModel = undefined; nextChildThinking = undefined;
          const path = present(args[args.indexOf("--session") + 1], "child session path");
          const savedId = readFileSync(path, "utf8").trim() ? JSON.parse(present(readFileSync(path, "utf8").split("\n")[0], "session header")).id : `session-${present(present(created, "tab environment").DS_HERDR_WORKER_ID, "worker id")}`;
          const child = fixture({ id: present(present(created, "tab environment").DS_HERDR_WORKER_ID, "worker id"), parent: present(present(created, "tab environment").DS_HERDR_PARENT_ID, "DS_HERDR_PARENT_ID"), role: present(present(created, "tab environment").DS_HERDR_ROLE, "DS_HERDR_ROLE"),
            model: present(childModel, "child model"), thinking: thinkingLevel(childThinking), sessionFile: path, sessionId: savedId,
            launchId: present(present(created, "tab environment").DS_HERDR_LAUNCH_ID, "DS_HERDR_LAUNCH_ID"), restart: present(present(created, "tab environment").DS_HERDR_RESTART_GENERATION, "DS_HERDR_RESTART_GENERATION") });
          await child.start();
          return execOk("{}");
        }
        return args[1] === "get" ? herdrResult({ pane: pane(present(args[2], "pane id")) }) : execOk();
      },
      sendUserMessage(text) { if (typeof text !== "string") throw new Error("expected user text"); selectionsAtSend.push({ id, model: key(present(ctx.model, "selected model")), thinking: level }); sends++;
        if (onSend) return onSend(text);
        void (async () => {
        await emit({ type: "input", source: "extension", text });
        await emit(beforeAgentStart({ cwd: root, prompt: text }));
        idle = false; await emit({ type: "agent_start" });
      })(); },
    });
    adapter(api);
    let onSend: ((text: string) => void) | undefined;
    const instance: SelectionFixture = { id, ctx, tools, sessionFile, emit, get onSend() { return onSend; }, set onSend(value: ((text: string) => void) | undefined) { onSend = value; },
      emitNow(event: ExtensionEvent) { return hooks.emitConcurrent(event, ctx); },
      get sends() { return sends; }, get level() { return level; },
      async start(reason: "startup" | "reload" = "startup") { await emit({ type: "session_start", reason }); if (error) throw Error(error); return readIdentity(id); },
      async stop() { await emit({ type: "session_shutdown", reason: "quit" }); },
      async settle() { idle = true; await emit(completedSettle()); await emit({ type: "agent_settled" }); },
      async changeThinking(value: ModelThinkingLevel) { level = clampThinkingLevel(present(ctx.model, "selected model"), value); await emit({ type: "thinking_level_select", level, previousLevel: level }); },
      async changeModel(value: Model<Api>) { const previousModel = ctx.model; ctx.model = value; level = clampThinkingLevel(value, level); await emit({ type: "thinking_level_select", level, previousLevel: level }); await emit({ type: "model_select", model: value, previousModel, source: "set" }); },
      async tool(name: string, params: Record<string, ReturnType<typeof JSON.parse>>) {
        const tool = tools.get(name);
        const validated = validateToolArguments(tool, { type: "toolCall", id: "test", name, arguments: params });
        return JSON.parse(toolText(await tool.execute("test", validated, undefined, undefined, ctx)));
      },
    };
    instances.push(instance); return instance;
  }
  const childFor = (receipt: { workerId: string }) => present(instances.findLast(instance => instance.id === receipt.workerId), "child instance");
  return { root, fixture, instances, commands, catalog, reasoning, plain, key, readIdentity, self, childFor, selectionsAtSend,
    controls: {
      get created() { return created; },
      set onPaneGet(value: typeof onPaneGet) { onPaneGet = value; },
      set nextChildThinking(value: ModelThinkingLevel | undefined) { nextChildThinking = value; },
    },
    async close() {
      await finishCleanup([], instances.reverse().map(instance => () => instance.stop()));
    },
  };
}
async function withSelection(check: (suite: Awaited<ReturnType<typeof selectionFixture>>) => Promise<void>) {
  const root = mkdtempSync("/tmp/pha-");
  const originalEnv = { ...process.env };
  let suite: Awaited<ReturnType<typeof selectionFixture>> | undefined;
  const errors: unknown[] = [];
  const restore = () => replaceEnvironment(originalEnv);
  const removeSockets = () => rmSync(socketDirectory(root, root), { recursive: true, force: true });
  const removeRoot = () => rmSync(root, { recursive: true, force: true });
  const ownedCleanup = ownTestCleanup(() => [() => suite?.close(), restore, removeSockets, removeRoot], [removeRoot, removeSockets, restore]);
  try {
    suite = await selectionFixture(root);
    await check(suite);
  } catch (error) {
    errors.push(error);
  } finally {
    await ownedCleanup.finish(errors);
  }
}

  for (const mode of ["followup", "launch"]) {
    for (const change of ["thinking", "model"]) {
test(`first-start selection survives ${mode} ${change} race`, { timeout: 30_000 }, () => withSelection(async ({ fixture, childFor, controls, instances, selectionsAtSend, reasoning, plain, root, key }) => {
  const lead = fixture(); await lead.start();
      let child: ReturnType<typeof fixture> | undefined;
      if (mode === "followup") {
        child = childFor(await lead.tool("spawn_agent", { role: "review", thinking: "low", task: "initial" }));
        await child.settle();
      }
      let paneChecks = 0;
      controls.onPaneGet = async args => {
        const target = child ?? instances.findLast(instance => instance.id === controls.created?.DS_HERDR_WORKER_ID);
        if (!target || args[2] !== target.id || ++paneChecks !== (mode === "launch" ? 3 : 2)) return;
        if (change === "thinking") await target.changeThinking("high");
        else await target.changeModel(plain);
      };
      const receipt: ReturnType<typeof JSON.parse> = mode === "launch"
        ? await lead.tool("spawn_agent", { role: "review", thinking: "low", task: "launch race" })
        : await lead.tool("followup_task", { agent_id: present(child, "follow-up child").id, task: "followup race" });
      controls.onPaneGet = undefined;
      child = childFor(receipt);
      const atSend = present(selectionsAtSend.at(-1), "send selection");
      assert.equal(receipt.kind, "accepted");
      assert.equal(atSend.thinking, change === "thinking" ? "high" : "off");
      assert.deepEqual(atSend.model, key(change === "model" ? plain : reasoning));
      assert.equal(receipt.identity.thinking, atSend.thinking, `${mode} ${change}: receipt must report the task's selection, not the first status snapshot`);
      assert.deepEqual(receipt.identity.model, atSend.model);
      const expected = { boundary: "agent_start", model: atSend.model, thinking: atSend.thinking };
      assert.deepEqual(receipt.selection, expected);
      const path = join(root, "tasks", child.id, `${receipt.submissionId}.json`);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).selection, expected);
      await child.changeModel(reasoning); await child.changeThinking("medium");
      await child.emit({ type: "agent_start" });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).selection, expected);
      await child.settle();
      const settled = await lead.tool("wait_agent", { agent_id: child.id, submission_id: receipt.submissionId, timeout_ms: 120000 });
      assert.deepEqual(settled.selection, expected);
      assert.deepEqual(receipt.selection, expected);
      const legacyTask = JSON.parse(readFileSync(path, "utf8")); delete legacyTask.selection;
      atomicWrite(path, legacyTask);
      const historical = await lead.tool("wait_agent", { agent_id: child.id, submission_id: receipt.submissionId, timeout_ms: 120000 });
      assert.equal(historical.selection, null);
}));

  }
}

test("unobserved launch has unknown selection and sends once", { timeout: 30_000 }, () => withSelection(async ({ fixture, controls, instances, childFor }) => {
  const lead = fixture(); await lead.start();
  let launchPaneChecks = 0;
  controls.onPaneGet = args => {
    const child = instances.findLast(instance => instance.id === controls.created?.DS_HERDR_WORKER_ID);
    if (child && args[2] === child.id && ++launchPaneChecks === 3) child.onSend = () => {};
  };
  const ambiguousLaunch = await lead.tool("spawn_agent", { role: "review", thinking: "low", task: "unobserved launch" });
  controls.onPaneGet = undefined;
  assert.equal(ambiguousLaunch.kind, "ambiguous"); assert.equal(ambiguousLaunch.selection, null);
  assert.equal(ambiguousLaunch.identity.model, null); assert.equal(ambiguousLaunch.identity.thinking, null);
  assert.equal(childFor(ambiguousLaunch).sends, 1);
  await childFor(ambiguousLaunch).stop();
}));

  for (const change of ["thinking", "model"]) {
test(`observes ${change} changed after send but before start`, { timeout: 30_000 }, () => withSelection(async ({ fixture, selectionsAtSend, reasoning, plain, root, key }) => {
  const lead = fixture(); await lead.start();
  const boundaryChild = fixture({ id: "boundary", parent: "lead", role: "review", thinking: "low" });
  await boundaryChild.start();
    await boundaryChild.changeThinking("low");
    boundaryChild.onSend = text => { void (async () => {
      await boundaryChild.emit({ type: "input", source: "extension", text });
      await boundaryChild.emit(beforeAgentStart({ cwd: root, prompt: text }));
      if (change === "thinking") await boundaryChild.changeThinking("high");
      else await boundaryChild.changeModel(plain);
      await boundaryChild.emit({ type: "agent_start" });
    })(); };
    const boundaryReceipt = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "start boundary" });
    assert.equal(present(selectionsAtSend.at(-1), "sent selection").thinking, "low");
    assert.equal(boundaryReceipt.identity.thinking, change === "thinking" ? "high" : "off", "observe at worker start, not caller status or send");
    assert.deepEqual(boundaryReceipt.identity.model, key(change === "thinking" ? reasoning : plain));
    await boundaryChild.settle();
}));

}

test("fast settlement caps bytes and retains first-start selection and full artifact", { timeout: 30_000 }, () => withSelection(async ({ fixture, reasoning, plain, root, key, self, readIdentity }) => {
  const lead = fixture(); await lead.start();
  const boundaryChild = fixture({ id: "boundary", parent: "lead", role: "review", thinking: "low" });
  await boundaryChild.start();
  await boundaryChild.changeModel(reasoning); await boundaryChild.changeThinking("high");

  boundaryChild.onSend = text => {
    void boundaryChild.emitNow({ type: "input", source: "extension", text });
    void boundaryChild.emitNow(beforeAgentStart({ cwd: root, prompt: text }));
    void boundaryChild.emitNow({ type: "agent_start" });
    void boundaryChild.emitNow({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100000) }], api: reasoning.api, provider: reasoning.provider, model: reasoning.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
    void boundaryChild.emitNow(completedSettle());
    void boundaryChild.emitNow({ type: "agent_settled" });
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
}));

test("unrelated start cannot attest task and late correlated start never replays", { timeout: 30_000 }, () => withSelection(async ({ fixture, plain, root }) => {
  const lead = fixture(); await lead.start();
  const boundaryChild = fixture({ id: "boundary", parent: "lead", role: "review", thinking: "low" });
  await boundaryChild.start();
  await boundaryChild.changeModel(plain);
  boundaryChild.onSend = () => { void boundaryChild.emit({ type: "agent_start" }); };
  const ambiguous = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "unobserved task" });
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal(ambiguous.selection, null); assert.equal(ambiguous.identity.model, null); assert.equal(ambiguous.identity.thinking, null);
  const beforeLateStart = boundaryChild.sends;
  const busy = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: "busy is still fenced" });
  assert.equal(busy.kind, "ambiguous"); assert.match(busy.reason, /busy/);
  assert.equal(busy.selection, null); assert.equal(boundaryChild.sends, beforeLateStart);
  const pendingPath = join(root, "tasks", boundaryChild.id, `${ambiguous.submissionId}.json`);
  const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
  assert.equal(pending.selection, null);
  const pendingText = `[ds-task ${pending.nonce}]\n${pending.task}`;
  await boundaryChild.emit({ type: "input", source: "extension", text: pendingText });
  await boundaryChild.emit(beforeAgentStart({ cwd: root, prompt: pendingText }));
  await boundaryChild.emit({ type: "agent_start" });
  assert.equal(boundaryChild.sends, beforeLateStart, "late observation does not replay submission");
  assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).selection.thinking, "off");
  assert.equal(ambiguous.selection, null, "earlier ambiguous receipt remains unknown");
  await boundaryChild.settle();
  await boundaryChild.stop();
}));

for (const replyMode of ["legacy", "mismatch", "invalid", "disconnect"]) {
test(`legacy endpoint ${replyMode} preserves unknown selection and correlation`, { timeout: 30_000 }, () => withSelection(async ({ fixture, plain, root, key, readIdentity }) => {
  const lead = fixture(); await lead.start();
  const boundaryChild = fixture({ id: "boundary", parent: "lead", role: "review", thinking: "low" });
  await boundaryChild.start();
  await boundaryChild.changeModel(plain);
  await boundaryChild.stop();
  const legacyEndpointIdentity = { ...readIdentity(boundaryChild.id), available: true };
  delete legacyEndpointIdentity.thinking;
  atomicWrite(join(root, "workers", `${boundaryChild.id}.json`), legacyEndpointIdentity);
  const sockets = new Set<Socket>();
  const legacyServer = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", chunk => {
      input += chunk; if (!input.includes("\n")) return;
      const message = JSON.parse(present(input.split("\n")[0], "legacy request"));
      const result = message.kind === "status" ? { kind: "status", identity: legacyEndpointIdentity, active: null, idle: true }
        : { kind: "accepted", workerId: boundaryChild.id, generation: legacyEndpointIdentity.generation,
          submissionId: replyMode === "mismatch" ? "different-task" : message.submissionId, evidence: "agent_start",
          ...(replyMode === "legacy" ? {} : { selection: { boundary: "agent_start", model: key(plain), thinking: replyMode === "invalid" ? "invented" : "off" } }) };
      if (replyMode === "disconnect" && message.kind === "submit") socket.destroy();
      else socket.end(JSON.stringify({ ok: true, result }) + "\n");
    });
  });
  const legacyFailures: unknown[] = [];
  const legacyCleanup = ownTestCleanup(() => [
    ...[...sockets].map(socket => () => socket.destroy()),
    () => new Promise<void>((resolve, reject) => legacyServer.close(error => error ? reject(error) : resolve())),
  ], []);
  try {
    await new Promise<void>((resolve, reject) => {
      legacyServer.once("error", reject);
      legacyServer.listen(legacyEndpointIdentity.socketPath, () => resolve());
    });
      const result = await lead.tool("followup_task", { agent_id: boundaryChild.id, task: replyMode });
      assert.equal(result.kind, replyMode === "legacy" ? "accepted" : "ambiguous");
      assert.equal(result.selection, null); assert.equal(result.identity.model, null); assert.equal(result.identity.thinking, null);
      assert.notEqual(result.submissionId, "different-task");
  } catch (error) {
    legacyFailures.push(error);
  } finally {
    await legacyCleanup.finish(legacyFailures);
  }
  atomicWrite(join(root, "workers", `${boundaryChild.id}.json`), { ...legacyEndpointIdentity, available: false });
}));

}

test("spawn schema requires thinking and leaves model optional", { timeout: 30_000 }, () => withSelection(async ({ fixture }) => {
  const lead = fixture(); await lead.start();
  const spawnSchema = lead.tools.get("spawn_agent").parameters;
  if (!("properties" in spawnSchema) || !("required" in spawnSchema) || !Array.isArray(spawnSchema.required)) throw new Error("expected spawn object schema");
  assert.ok(spawnSchema.properties && typeof spawnSchema.properties === "object" && "model" in spawnSchema.properties, "spawn exposes model override");
  assert.ok(spawnSchema.required.includes("thinking"), "spawn requires thinking");
  assert.ok(!spawnSchema.required.includes("model"), "model remains optional");
}));

  for (const role of ["explore", "implement", "review", "judgment"]) {
    for (const thinking of ["low", "high"]) {
test(`${role} with ${thinking} keeps explicit role-independent selection`, { timeout: 30_000 }, () => withSelection(async ({ fixture, childFor, reasoning, key }) => {
  const lead = fixture(); await lead.start();
      const receipt = await lead.tool("spawn_agent", { role, thinking, task: "brief" });
      assert.equal(receipt.kind, "accepted");
      assert.deepEqual(receipt.identity.model, key(reasoning));
      assert.equal(receipt.identity.thinking, thinking, "level is independent of role");
      assert.equal(childFor(receipt).level, thinking);
      await childFor(receipt).settle();
}));

  }
}

test("explicit model overrides parent and nested spawn inherits immediate caller", { timeout: 30_000 }, () => withSelection(async ({ fixture, childFor, plain, key }) => {
  const lead = fixture(); await lead.start();
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
}));

test("accepts explicit off for a nonreasoning model", { timeout: 30_000 }, () => withSelection(async ({ fixture, plain, key }) => {
  const lead = fixture(); await lead.start();
  const explicitOff = await lead.tool("spawn_agent", { role: "judgment", task: "brief", model: key(plain), thinking: "off" });
  assert.equal(explicitOff.identity.thinking, "off");
}));

  for (const role of ["explore", "implement", "review", "judgment"]) {
test(`missing thinking for ${role} allocates nothing`, { timeout: 30_000 }, () => withSelection(async ({ fixture, commands, root }) => {
  const lead = fixture(); await lead.start();
  const snapshot = () => JSON.stringify({ commands: commands.length, locks: readdirSync(join(root, "locks")), sessions: readdirSync(join(root, "sessions")), operations: readdirSync(join(root, "operations")) });
  const before = snapshot();
    await assert.rejects(lead.tool("spawn_agent", { role, task: "brief" }), /Validation failed[\s\S]*thinking/);
    assert.equal(snapshot(), before, "missing thinking is rejected by Pi's schema validator before allocation");
}));

}

  for (const thinking of [undefined, null, "", "invented", 42]) {
test(`invalid thinking ${JSON.stringify(thinking)} is rejected`, { timeout: 30_000 }, () => withSelection(async ({ fixture }) => {
  const lead = fixture(); await lead.start();
    await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", thinking }), /Validation failed[\s\S]*thinking/);
}));

}

test("unsupported model or thinking allocates no claim, receipt, session, or tab", { timeout: 30_000 }, () => withSelection(async ({ fixture, commands, root, reasoning, plain, key }) => {
  const lead = fixture(); await lead.start();
  const snapshot = () => JSON.stringify({ commands: commands.length, locks: readdirSync(join(root, "locks")), sessions: readdirSync(join(root, "sessions")), operations: readdirSync(join(root, "operations")) });
  const before = snapshot();
  await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", model: key(plain), thinking: "high" }), /Unsupported thinking.*off/);
  await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", model: { provider: "unknown", id: "absent" }, thinking: "high" }), /Unknown model/);
  const unsupported = (["max", "xhigh", "minimal"] as const).find(level => !getSupportedThinkingLevels(reasoning).includes(level));
  assert.ok(unsupported);
  await assert.rejects(lead.tool("spawn_agent", { role: "review", task: "brief", thinking: unsupported }), /Unsupported thinking/);
  assert.equal(snapshot(), before, "invalid choices allocate no claim, receipt, session or tab");
}));

test("missing auth rejects before allocation and unavailable followup carries no selection", { timeout: 30_000 }, () => withSelection(async ({ fixture, commands, root }) => {
  const lead = fixture(); await lead.start();
  const snapshot = () => JSON.stringify({ commands: commands.length, locks: readdirSync(join(root, "locks")), sessions: readdirSync(join(root, "sessions")), operations: readdirSync(join(root, "operations")) });
  const noauth = fixture({ id: "noauth", parent: "lead", role: "review", auth: false }); await noauth.start();
  const beforeAuth = snapshot();
  await assert.rejects(noauth.tool("spawn_agent", { role: "review", task: "brief", thinking: "medium" }), /authentication/);
  assert.equal(snapshot(), beforeAuth, "missing auth rejected before allocation");
  const rejected = await lead.tool("followup_task", { agent_id: noauth.id, task: "preflight rejection" });
  assert.equal(rejected.kind, "unavailable"); assert.equal(noauth.sends, 0);
  assert.equal(rejected.selection, null); assert.equal(rejected.identity.model, null); assert.equal(rejected.identity.thinking, null);
  await noauth.stop();
}));

test("legacy same-process reload captures native thinking", { timeout: 30_000 }, () => withSelection(async ({ fixture, root, readIdentity }) => {
  const lead = fixture(); await lead.start();
  const noauth = fixture({ id: "noauth", parent: "lead", role: "review", auth: false }); await noauth.start();
  await noauth.stop();
  const legacyLive = readIdentity("noauth"); delete legacyLive.thinking;
  atomicWrite(join(root, "workers", "noauth.json"), legacyLive);
  const migrated = fixture({ id: "noauth", parent: "lead", role: "review", thinking: "low" });
  assert.equal((await migrated.start("reload")).thinking, "low", "legacy same-process reload captures native effort, not role default");
  const migratedReceipt = await lead.tool("followup_task", { agent_id: "noauth", task: "new legacy task" });
  assert.equal(migratedReceipt.identity.thinking, "low"); await migrated.settle(); await migrated.stop();
}));

test("native selection changes survive live followup, empty-history reload, and cold continuation", { timeout: 30_000 }, () => withSelection(async ({ fixture, childFor, plain, key, root, readIdentity }) => {
  const lead = fixture(); await lead.start();
  const overridden = await lead.tool("spawn_agent", { role: "explore", task: "brief", thinking: "high" });
  const child = childFor(overridden);
  assert.equal(child.level, "high", "worker startup must not reset explicit thinking to role default");
  await child.settle();
  await child.changeThinking("low");
  let followup = await lead.tool("followup_task", { agent_id: present(child, "follow-up child").id, task: "new task" });
  assert.equal(followup.identity.thinking, "low"); await child.settle();
  await child.changeModel(plain);
  assert.equal(readIdentity(child.id).thinking, "off");
  assert.deepEqual(readIdentity(child.id).model, key(plain));
  const listed: { identity: { workerId: string; thinking: ModelThinkingLevel | null } }[] = await lead.tool("list_agents", {});
  assert.equal(present(listed.find(row => row.identity.workerId === child.id), "listed child").identity.thinking, "off");
  await child.stop();
  assert.equal(readFileSync(child.sessionFile, "utf8"), "", "empty-history fixture has no native entries");
  rmSync(child.sessionFile);
  const reload = fixture({ id: child.id, parent: "lead", role: "explore", model: plain, thinking: "off", sessionFile: child.sessionFile, launchId: "released-initial-claim" });
  const reloaded = await reload.start("reload");
  assert.equal(reloaded.thinking, "off"); assert.equal(reload.sends, 0);
  await reload.stop();
  writeFileSync(child.sessionFile, JSON.stringify({ type: "session", id: reloaded.piSessionId }) + "\n");
  atomicWrite(join(root, "workers", `${child.id}.json`), { ...readIdentity(child.id), pidBirth: "dead-process" });
  followup = await lead.tool("followup_task", { agent_id: present(child, "follow-up child").id, task: "cold new task" });
  assert.equal(followup.identity.thinking, "off"); assert.deepEqual(followup.identity.model, key(plain));
  assert.equal(followup.identity.piSessionId, reloaded.piSessionId);
  assert.notEqual(followup.generation, reloaded.generation);
  assert.equal(childFor(followup).sends, 1, "cold recovery submits only new task");
  await childFor(followup).settle(); await childFor(followup).stop();
}));

test("legacy cold selection refuses unknown effort and restores native active branch without opening writer", { timeout: 30_000 }, () => withSelection(async ({ fixture, childFor, plain, key, root, readIdentity, commands }) => {
  const lead = fixture(); await lead.start();
  const child = childFor(await lead.tool("spawn_agent", { role: "explore", model: key(plain), thinking: "off", task: "initial" }));
  await child.settle(); await child.stop();
  writeFileSync(child.sessionFile, JSON.stringify({ type: "session", id: readIdentity(child.id).piSessionId }) + "\n");
  const snapshot = () => JSON.stringify({ commands: commands.length, locks: readdirSync(join(root, "locks")), sessions: readdirSync(join(root, "sessions")), operations: readdirSync(join(root, "operations")) });
  const legacy = readIdentity(child.id); delete legacy.thinking;
  atomicWrite(join(root, "workers", `${child.id}.json`), { ...legacy, pidBirth: "dead-process" });
  const legacyBefore = snapshot();
  await assert.rejects(lead.tool("followup_task", { agent_id: present(child, "follow-up child").id, task: "do not guess effort" }), /thinking.*unknown/i);
  assert.equal(snapshot(), legacyBefore);
  const legacyRows: { identity: { workerId: string; thinking: ModelThinkingLevel | null } }[] = await lead.tool("list_agents", {});
  assert.equal(present(legacyRows.find(row => row.identity.workerId === child.id), "legacy child").identity.thinking, null);
  assert.throws(() => parseIdentity({ ...legacy, thinking: "invented" }), /Invalid/);
  const legacyNative = SessionManager.inMemory(root, { id: legacy.piSessionId });
  legacyNative.appendModelChange(plain.provider, plain.id);
  const branch = legacyNative.appendThinkingLevelChange("off");
  legacyNative.appendThinkingLevelChange("high");
  legacyNative.branch(branch);
  legacyNative.appendCustomEntry("branch-proof", {});
  const legacyContents = [legacyNative.getHeader(), ...legacyNative.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(child.sessionFile, legacyContents);
  const legacyReceipt = await lead.tool("followup_task", { agent_id: present(child, "follow-up child").id, task: "legacy new task" });
  assert.equal(legacyReceipt.identity.thinking, "off", "restore latest native branch, not abandoned high entry");
  assert.equal(readFileSync(child.sessionFile, "utf8"), legacyContents, "legacy lookup never opens a native writer");
  await childFor(legacyReceipt).settle(); await childFor(legacyReceipt).stop();
  writeFileSync(child.sessionFile, legacyContents + "{broken\n");
  assert.throws(() => recordedThinking(parseIdentity(legacy)), /Malformed native history/);
  writeFileSync(child.sessionFile, legacyContents);
}));

test("sparse model levels accept high and max but reject off", { timeout: 30_000 }, () => withSelection(async ({ fixture, reasoning, key }) => {
  const lead = fixture(); await lead.start();
  const sparse = { ...reasoning, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } };
  const sparseCtx = { ...lead.ctx, modelRegistry: fakeRegistry({ ...lead.ctx.modelRegistry, find: () => sparse }) };
  assert.throws(() => selectWorker(sparseCtx, { model: key(sparse), thinking: "off" }), /supported: high, max/);
  assert.equal(selectWorker(sparseCtx, { model: key(sparse), thinking: "high" }).thinking, "high");
  assert.equal(selectWorker(sparseCtx, { model: key(sparse), thinking: "max" }).thinking, "max");
}));

test("real SDK events, empty-history reload, and cold continuation preserve selection", { timeout: 30_000 }, () => withSelection(async ({ fixture, root, catalog, reasoning, plain, key, readIdentity, childFor }) => {
  const lead = fixture(); await lead.start();
  const agentDir = join(root, "sdk-config");
  const settingsManager = SettingsManager.inMemory();
  const errors: ExtensionError[] = [], renderedPrompts: string[] = [];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => adapter({ ...pi, exec: async (_command, args) => {
      const op = herdrArgs(args);
      return op[1] === "get" ? herdrResult({ pane: pane(present(op[2], "SDK pane id")) }) : execOk();
    } }), pi => pi.on("before_agent_start", event => { renderedPrompts.push(event.systemPrompt); })] });
  Object.assign(process.env, { DS_HERDR_WORKER_ID: "sdk-worker", DS_HERDR_PARENT_ID: "lead", DS_HERDR_ROLE: "review",
    HERDR_PANE_ID: "sdk-worker", DS_HERDR_LAUNCH_ID: "", DS_HERDR_RESTART_GENERATION: "" });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  await catalog.setRuntimeApiKey("openai", "fixture-not-a-real-key");
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: catalog, model: reasoning, thinkingLevel: "high", sessionManager: SessionManager.create(root, join(root, "sdk-sessions")) });
  const sdkFailures: unknown[] = [];
  const ownedSession = ownTestCleanup(() => [
    () => { Object.assign(process.env, { HERDR_ENV: "0" }); },
    () => session.reload(),
    () => session.dispose(),
    () => { Object.assign(process.env, { HERDR_ENV: "1" }); },
  ], []);
  try {
    await session.bindExtensions({ mode: "tui", onError: error => { errors.push(error); } });
    assert.deepEqual(errors, []);
    assert.equal(readIdentity("sdk-worker").thinking, "high", "native SDK startup retains selected effort");
    await session.extensionRunner.emitBeforeAgentStart("probe", undefined, { cwd: root, customPrompt: "CUSTOM PROMPT" });
    assert.match(present(renderedPrompts.at(-1), "rendered prompt"), /^CUSTOM PROMPT[\s\S]*Role: review\. An agent started you/, "role brief survives a custom system prompt");
    session.setThinkingLevel("low");
    assert.equal(readIdentity("sdk-worker").thinking, "low", "native thinking event persists before any status poll or await");
    await session.setModel(plain);
    assert.deepEqual(readIdentity("sdk-worker").model, key(plain));
    assert.equal(readIdentity("sdk-worker").thinking, "off", "native model-change clamp persists paired selection");
    assert.equal(existsSync(present(session.sessionFile, "SDK session file")), false, "Pi has not flushed empty session history");
    const beforeReload = readIdentity("sdk-worker");
    await session.reload();
    assert.deepEqual(errors, []);
    const afterReload = readIdentity("sdk-worker");
    assert.notEqual(afterReload.generation, beforeReload.generation);
    assert.equal(afterReload.piSessionId, beforeReload.piSessionId);
    assert.deepEqual(afterReload.model, key(plain)); assert.equal(afterReload.thinking, "off");
  } catch (error) {
    sdkFailures.push(error);
  } finally {
    await ownedSession.finish(sdkFailures);
  }

  const nativeSaved = readIdentity("sdk-worker");
  writeFileSync(nativeSaved.piSessionPath, JSON.stringify({ type: "session", id: nativeSaved.piSessionId }) + "\n");
  atomicWrite(join(root, "workers", "sdk-worker.json"), { ...nativeSaved, pidBirth: "dead-sdk-process" });
  const sdkCold = await lead.tool("followup_task", { agent_id: "sdk-worker", task: "new task after native selection changes" });
  assert.deepEqual(sdkCold.identity.model, key(plain)); assert.equal(sdkCold.identity.thinking, "off");
  await childFor(sdkCold).settle(); await childFor(sdkCold).stop();
}));

test("child thinking mismatch retains launch fence without changing lead effort", { timeout: 30_000 }, () => withSelection(async ({ fixture, root, controls, commands }) => {
  const lead = fixture(); await lead.start();
  controls.nextChildThinking = "low";
  await assert.rejects(lead.tool("spawn_agent", { role: "judgment", task: "brief", thinking: "high" }), /thinking mismatch/);
  const mismatchLaunch = present(commands.findLast(args => args[0] === "agent"), "mismatched launch");
  const mismatchId = present(mismatchLaunch[2], "mismatched child command").slice(0, -9);
  assert.ok(existsSync(join(root, "locks", `launch-${mismatchId}`, "claim.json")), "unknown child identity keeps launch fence");
  assert.equal(lead.level, "high", "lead effort unchanged");
}));
