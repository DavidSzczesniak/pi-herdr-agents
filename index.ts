import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { StringEnum, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extensionPath, herdrCommand, privateDirectory, startupConfig, type StartupConfig } from "./startup.ts";
import { atomicWrite, errorText, ModelSchema, ThinkingSchema, parse, readIdentityRecord, readRecord, RequestSchema, request, SafeId, socketAlive, TaskSchema, type Identity, type Request, type Result, type Selection, type Task } from "./protocol.ts";
import { claimLaunch, LaunchClaimSchema, isOriginalProcessLive, PaneResponse, PlanRecordSchema, PlanSchema, planLines, processIdentity, recordedThinking, roleBrief, selectWorker, tabPane, verifySession, type Pane } from "./runtime.ts";

const toolNames = ["spawn_agent", "list_agents", "wait_agent", "followup_task", "interrupt_agent", "update_plan"];
const normalTools = ["read", "grep", "find", "ls", "bash", "edit", "write", ...toolNames];
const idSchema = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" });
const targetFields = { agent_id: idSchema, submission_id: idSchema };

export default function (pi: ExtensionAPI) {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: resolve(getAgentDir()) };
  let runtime: ReturnType<typeof createRuntime> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (runtime) return;
    try {
      const config = startupConfig(ctx, env);
      if (!config) return;
      runtime = createRuntime(pi, config);
      await runtime.startup(ctx, _event.reason);
      runtime.registerTools();
    } catch (error) {
      await runtime?.cleanup().catch(() => {});
      ctx.ui.notify(`Herdr adapter disabled: ${errorText(error)}`, "error");
      if (env.DS_HERDR_WORKER_ID && env.DS_HERDR_WORKER_ID !== "lead") {
        ctx.shutdown();
        throw error;
      }
    }
  });
  pi.on("session_shutdown", async () => { await runtime?.cleanup(); });
}

function createRuntime(pi: ExtensionAPI, config: StartupConfig) {
  const { stateDir, socketDir, workerId, parentId, role, herdrSession, cwd, paneId } = config;
  let workspaceId = config.workspaceId;
  const generation = randomUUID();
  const socketPath = join(socketDir, `${generation}.sock`);
  const identityPath = (id: string) => join(stateDir, "workers", `${parse(SafeId, id)}.json`);
  const taskPath = (id: string) => join(stateDir, "tasks", workerId, `${parse(SafeId, id)}.json`);
  const lockPath = join(stateDir, "locks", workerId);
  let identity: Identity | undefined;
  let server: Server | undefined;
  let context: ExtensionContext | undefined;
  let active: Extract<Task, { kind: "active" }> | undefined;
  let assistants: AssistantMessage[] = [];
  let boundaryOutcome: "completed" | "interrupted" | "error" | undefined;
  let runSignal: AbortSignal | undefined;
  let startNonce: string | undefined;
  let accepted: (() => void) | undefined;
  let shuttingDown = false;
  let shutdownCleaned = false;
  let sequence = Date.now();
  let reportQueue = Promise.resolve();
  const launches = new Set<Promise<unknown>>();
  const detachedPath = join(stateDir, "locks", `${workerId}.detached.json`);
  const connections = new Set<Socket>();
  const waiters = new Map<string, Set<(result: Task) => void>>();

  function audit(event: string, data: unknown = {}) {
    if (!identity) return;
    appendFileSync(join(stateDir, "audit", `${workerId}.ndjson`), JSON.stringify({
      at: new Date().toISOString(), workerId, generation, submissionId: active?.submissionId ?? null, event, data,
    }) + "\n", { mode: 0o600 });
  }
  function current(): Identity {
    if (!identity || shuttingDown) throw new Error("Worker unavailable");
    return identity;
  }
  function readIdentity(id: string): Identity { return readIdentityRecord(identityPath(id)); }
  function isDescendant(targetId: string, callerId: string): boolean {
    const seen = new Set<string>();
    let next: string | null = targetId;
    while (next && !seen.has(next)) {
      seen.add(next);
      const record = readIdentity(next);
      if (record.herdrSession !== herdrSession) return false;
      next = record.parentId;
      if (next === callerId) return true;
    }
    return false;
  }
  function owned(id: string): Identity {
    current();
    if (id === workerId || !isDescendant(id, workerId)) throw new Error("Target is not this caller's descendant");
    return readIdentity(id);
  }
  async function herdr(args: string[], signal?: AbortSignal): Promise<unknown> {
    const output = await pi.exec("env", herdrCommand(config, args), { timeout: 30000, signal });
    if (output.code !== 0 || output.killed) throw new Error(`Herdr ${args.slice(0, 2).join(" ")}: ${output.stderr || output.stdout}`);
    if (args[0] === "pane" && ["report-agent", "release-agent", "close"].includes(args[1] ?? "") && !output.stdout.trim()) return undefined;
    return JSON.parse(output.stdout);
  }
  function report(state: "idle" | "working") {
    const own = current();
    const seq = ++sequence;
    const pending = reportQueue.then(async () => {
      await herdr(["pane", "report-agent", paneId, "--source", "ds-slice", "--agent", "pi", "--state", state,
        "--seq", String(seq), "--agent-session-id", own.piSessionId, "--agent-session-path", own.piSessionPath]);
    });
    reportQueue = pending.catch((error) => audit("report_error", { error: errorText(error) }));
    return pending;
  }
  function publicTask(task: Task): Task {
    const result = { ...task, task: "", selection: task.selection ?? null };
    if (result.kind === "settled") {
      while (Buffer.byteLength(JSON.stringify(result)) > 45000) result.finalText = result.finalText.slice(0, Math.floor(result.finalText.length * 0.8));
    }
    return result;
  }
  function publish(task: Task) {
    atomicWrite(taskPath(task.submissionId), task);
    audit("task_settlement", { submissionId: task.submissionId, kind: task.kind, outcome: task.kind === "settled" ? task.outcome : null });
    active = undefined;
    accepted?.();
    for (const finish of [...(waiters.get(task.submissionId) ?? [])]) finish(publicTask(task));
  }
  async function live(target: Identity, signal?: AbortSignal): Promise<Identity> {
    if (!target.available || !isOriginalProcessLive(target)) throw new Error("Original worker process unavailable");
    const { pane } = parse(PaneResponse, await herdr(["pane", "get", target.paneId], signal)).result;
    if (pane.pane_id !== target.paneId || pane.terminal_id !== target.terminalId || pane.workspace_id !== workspaceId) throw new Error("Herdr pane mismatch");
    const own = current();
    const result = await request(target.socketPath, { kind: "status", callerId: workerId,
      callerGeneration: own.generation, generation: target.generation }, signal);
    if (result.kind !== "status" || result.identity.workerId !== target.workerId || result.identity.generation !== target.generation ||
      result.identity.paneId !== target.paneId || result.identity.pidBirth !== target.pidBirth || result.identity.pid !== target.pid ||
      result.identity.piSessionId !== target.piSessionId || result.identity.piSessionPath !== target.piSessionPath)
      throw new Error("Runtime identity mismatch");
    return result.identity;
  }
  async function call(target: Identity, operation: { kind: "submit"; submissionId: string; task: string } | { kind: "wait" | "interrupt"; submissionId: string; timeoutMs: number }, signal?: AbortSignal) {
    if (operation.kind === "wait") {
      if (!isOriginalProcessLive(target)) {
        await proveDead(target);
        retireActive(target, "Original process died without settlement; unavailable, never replayed");
      }
      const task = readRecord(TaskSchema, join(stateDir, "tasks", target.workerId, `${parse(SafeId, operation.submissionId)}.json`));
      if (task.workerId !== target.workerId || task.piSessionId !== target.piSessionId || task.submissionId !== operation.submissionId) throw new Error("Task conversation mismatch");
      if (task.kind !== "active") return publicTask(task);
      if (task.generation !== target.generation) throw new Error("Old active task requires death reconciliation, not a wait on the new run");
    }
    await live(target, signal);
    return request(target.socketPath, { ...operation, callerId: workerId, callerGeneration: current().generation, generation: target.generation }, signal);
  }
  function waitForTask(task: Task, timeoutMs: number, socket: Socket): Promise<Result> {
    if (task.kind !== "active") return Promise.resolve(publicTask(task));
    if (task.phase === "ambiguous") return Promise.resolve({ kind: "ambiguous", workerId, generation, submissionId: task.submissionId, selection: null,
      reason: "No correlated agent_start observed. Needs operator reset_pending and confirmed process exit; never replay." });
    return new Promise((resolve) => {
      const callbacks = waiters.get(task.submissionId) ?? new Set();
      waiters.set(task.submissionId, callbacks);
      const finish = (result: Result) => {
        clearTimeout(timer);
        callbacks.delete(finish);
        if (!callbacks.size) waiters.delete(task.submissionId);
        socket.off("close", disconnected);
        resolve(result);
      };
      const disconnected = () => finish({ kind: "timeout", workerId, generation, submissionId: task.submissionId, active: true });
      const timer = setTimeout(disconnected, timeoutMs);
      callbacks.add(finish);
      socket.once("close", disconnected);
      if (socket.destroyed) disconnected();
    });
  }
  async function handle(message: Request, socket: Socket): Promise<Result> {
    const own = current();
    if (message.generation !== generation) throw new Error("Stale target generation");
    const caller = readIdentity(message.callerId);
    if (!caller.available || caller.generation !== message.callerGeneration || caller.herdrSession !== herdrSession) throw new Error("Stale caller generation");
    if (message.callerId !== workerId && !isDescendant(workerId, message.callerId)) throw new Error("Caller does not own target");
    audit("socket_request", { kind: message.kind, callerId: message.callerId, submissionId: "submissionId" in message ? message.submissionId : null });
    if (message.kind === "status") return { kind: "status", identity: own, active: active ? publicTask(active) : null, idle: context?.isIdle() ?? false };
    if (message.kind === "submit") {
      if (existsSync(taskPath(message.submissionId))) throw new Error("Duplicate submission ID; not executed");
      if (active || !context?.isIdle() || context.hasPendingMessages()) throw new Error("Worker busy; concurrent submit rejected");
      const reservation: Extract<Task, { kind: "active" }> = { kind: "active", phase: "pending", nonce: randomUUID(), workerId, generation,
        piSessionId: own.piSessionId, submissionId: message.submissionId, task: message.task, startedAt: new Date().toISOString(), selection: null };
      active = reservation;
      assistants = [];
      boundaryOutcome = undefined;
      runSignal = undefined;
      startNonce = undefined;
      atomicWrite(taskPath(message.submissionId), active);
      // This check rejects known configuration failures before calling the void API.
      if (!context.model || (!context.modelRegistry.hasConfiguredAuth(context.model) && !context.modelRegistry.getProviderAuthStatus(context.model.provider).configured)) {
        const rejected: Task = { ...reservation, kind: "unavailable", reason: "Rejected before sendUserMessage: no model or configured provider authentication. Not submitted; no replay." };
        publish(rejected);
        return publicTask(rejected);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observed = new Promise<void>((resolve) => { accepted = resolve; timer = setTimeout(resolve, 5000); });
      try {
        pi.sendUserMessage(`[ds-task ${reservation.nonce}]\n${message.task}`, { expandPromptTemplates: false });
        await observed;
      } catch (error) { audit("submission_exception", { error: errorText(error) }); }
      finally { clearTimeout(timer); accepted = undefined; }
      const saved = readRecord(TaskSchema, taskPath(message.submissionId));
      if (saved.kind !== "active") return publicTask(saved);
      if (saved.phase === "started") return { kind: "accepted", workerId, generation, submissionId: message.submissionId, evidence: "agent_start", selection: saved.selection ?? null };
      active = { ...saved, phase: "ambiguous" };
      atomicWrite(taskPath(message.submissionId), active);
      return { kind: "ambiguous", workerId, generation, submissionId: message.submissionId, selection: null,
        reason: "Durable pending submission; no correlated start within 5 seconds. May still start. Never replay; inspect then operator reset_pending if needed." };
    }
    const task = readRecord(TaskSchema, taskPath(message.submissionId));
    if (task.workerId !== workerId || task.piSessionId !== own.piSessionId || task.submissionId !== message.submissionId) throw new Error("Task identity mismatch");
    if (message.kind === "reset_pending" || (message.kind === "interrupt" && task.kind === "active" && task.phase !== "started")) {
      if (task.generation !== generation || task.kind !== "active" || task.phase === "started" || active?.submissionId !== task.submissionId)
        throw new Error("Reset only applies to exact unresolved preflight");
      audit("operator_reset_pending", { submissionId: task.submissionId });
      publish({ ...task, kind: "unavailable", reason: "Operator reset of uncertain preflight; original task will not be replayed" });
      shuttingDown = true;
      context?.abort();
      setTimeout(() => context?.shutdown(), 50);
      return { kind: "reset_requested", workerId, generation, submissionId: task.submissionId,
        reason: "Shutdown requested, not confirmed. Prove original PID/birth dead before followup_task; bound operator wait and escalate explicitly if still live." };
    }
    if (task.kind === "active" && task.generation !== generation) throw new Error("Stale active task generation");
    if (message.kind === "interrupt" && task.generation !== generation) throw new Error("Cannot interrupt an old generation");
    if (task.kind === "active" && active?.submissionId !== task.submissionId) throw new Error("Task has no matching runtime execution");
    const waiting = waitForTask(task, message.timeoutMs, socket);
    if (message.kind === "interrupt" && task.kind === "active") {
      audit("interrupt_requested", { submissionId: task.submissionId });
      context?.abort();
    }
    return waiting;
  }
  function serve(socket: Socket) {
    connections.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let dispatched = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => clearTimeout(timer));
    socket.on("data", (chunk: string) => {
      if (dispatched) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      dispatched = true;
      clearTimeout(timer);
      const respond = (value: unknown) => { if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n"); };
      try {
        const message = parse(RequestSchema, JSON.parse(buffer.slice(0, end)));
        void handle(message, socket).then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: errorText(error) }));
      } catch (error) { respond({ ok: false, error: errorText(error) }); }
    });
  }
  function isDetached(previous: Identity): boolean {
    return !previous.available && !existsSync(lockPath) && existsSync(detachedPath) &&
      readRecord(Type.Object({ generation: SafeId }), detachedPath).generation === previous.generation;
  }
  async function startup(ctx: ExtensionContext, reason: SessionStartEvent["reason"]) {
    context = ctx;
    if (resolve(ctx.cwd) !== resolve(cwd)) throw new Error("Worker cwd mismatch");
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) throw new Error("Explicit persistent Pi session required");
    privateDirectory(stateDir);
    privateDirectory(dirname(socketDir));
    privateDirectory(socketDir);
    const bindingPath = join(stateDir, "binding.json");
    const bindingSchema = Type.Object({ herdrSocket: Type.String(), herdrSession: Type.String() });
    if (existsSync(bindingPath)) {
      const binding = readRecord(bindingSchema, bindingPath);
      if (binding.herdrSocket !== config.herdrSocket || binding.herdrSession !== herdrSession) throw new Error("Herdr endpoint binding mismatch");
    } else {
      writeFileSync(bindingPath, JSON.stringify({ herdrSocket: config.herdrSocket, herdrSession }), { flag: "wx", mode: 0o600 });
    }
    for (const name of ["workers", "tasks", "sessions", "audit", "locks", "artifacts", "plans", "operations"]) privateDirectory(join(stateDir, name));
    privateDirectory(join(stateDir, "tasks", workerId));
    const { pane } = parse(PaneResponse, await herdr(["pane", "get", paneId])).result;
    if (pane.pane_id !== paneId || (workspaceId && pane.workspace_id !== workspaceId)) throw new Error("Explicit private workspace/pane mismatch");
    workspaceId = pane.workspace_id;
    if (parentId) {
      const parent = readIdentity(parentId);
      if (parent.herdrSession !== herdrSession || parent.workspaceId !== workspaceId) throw new Error("Parent identity mismatch");
    }
    const birth = processIdentity(process.pid);
    if (!birth) throw new Error("Own Linux process identity unavailable");
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    const previous = existsSync(identityPath(workerId)) ? readIdentity(workerId) : undefined;
    const workerReload = reason === "reload" && role !== "lead" && previous && previous.pid === process.pid &&
      previous.pidBirth === birth.birth && isDetached(previous);
    const launchId = config.launchId;
    if (launchId && !workerReload) {
      const claim = readRecord(LaunchClaimSchema, join(stateDir, "locks", `launch-${workerId}`, "claim.json"));
      if (claim.launchId !== launchId || claim.workerId !== workerId || claim.piSessionPath !== sessionPath ||
        claim.previousGeneration !== config.restartGeneration ||
        claim.model.provider !== model?.provider || claim.model.id !== model?.id) throw new Error("Native launch claim or selected model mismatch");
      if (claim.thinking !== pi.getThinkingLevel()) throw new Error("Native launch thinking mismatch");
    }
    if (previous) {
      if ((!config.automatic && !workerReload && config.restartGeneration !== previous.generation) || previous.parentId !== parentId || previous.role !== role ||
        previous.herdrSession !== herdrSession || previous.workspaceId !== workspaceId || previous.cwd !== cwd ||
        previous.piSessionId !== ctx.sessionManager.getSessionId() || previous.piSessionPath !== sessionPath ||
        (!config.automatic && (previous.model?.provider !== model?.provider || previous.model?.id !== model?.id ||
          (previous.thinking !== null && previous.thinking !== pi.getThinkingLevel()))))
        throw new Error("Identity exists; explicit matching restart generation and original Pi session required");
      const claim = join(stateDir, "locks", `restart-${previous.generation}`);
      mkdirSync(claim);
      try {
        const detached = (config.automatic || workerReload) && isDetached(previous);
        if (detached) {
          if (await socketAlive(previous.socketPath)) throw new Error("Detached endpoint still live or unknown");
          // Pi may not flush an empty conversation yet. The same live native runtime
          // supplies the matching UUID/path above; cold opens still require the header.
          if (previous.pid !== process.pid || previous.pidBirth !== birth.birth) verifySession(previous);
        } else await proveDead(previous);
        if (readIdentity(workerId).generation !== previous.generation) throw new Error("Restart generation changed");
        rmSync(previous.socketPath, { force: true });
        if (existsSync(lockPath)) {
          if (readFileSync(join(lockPath, "generation"), "utf8") !== previous.generation) throw new Error("Lock generation mismatch; cleanup refused");
          renameSync(lockPath, `${lockPath}.retired-${previous.generation}-${generation}`);
        }
        retireActive(previous, "Original process died without settlement; unavailable, never replayed");
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, "generation"), generation, { mode: 0o600 });
        identity = { workerId, parentId, role, herdrSession, workspaceId, paneId, terminalId: pane.terminal_id, generation, socketPath,
          pid: process.pid, pidBirth: birth.birth, piSessionId: ctx.sessionManager.getSessionId(), piSessionPath: sessionPath, cwd, available: true, model, thinking: pi.getThinkingLevel() };
        atomicWrite(identityPath(workerId), identity);
      } finally { rmSync(claim, { recursive: true, force: true }); }
    } else {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "generation"), generation, { mode: 0o600 });
      identity = { workerId, parentId, role, herdrSession, workspaceId, paneId, terminalId: pane.terminal_id, generation, socketPath,
        pid: process.pid, pidBirth: birth.birth, piSessionId: ctx.sessionManager.getSessionId(), piSessionPath: sessionPath, cwd, available: true, model, thinking: pi.getThinkingLevel() };
      atomicWrite(identityPath(workerId), identity);
    }
    server = createServer(serve);
    await new Promise<void>((resolve, reject) => { server?.once("error", reject); server?.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    atomicWrite(identityPath(workerId), identity);
    const planPath = join(stateDir, "plans", `${workerId}.json`);
    if (existsSync(planPath)) {
      const plan = readRecord(PlanRecordSchema, planPath);
      if (plan.workerId !== workerId || plan.piSessionId !== identity.piSessionId) throw new Error("Plan session mismatch");
      if (ctx.hasUI) ctx.ui.setWidget("ds-plan", planLines(plan));
    }
    await report("idle");
  }
  pi.on("model_select", (event) => {
    if (!identity || shuttingDown) return;
    identity = { ...identity, model: { provider: event.model.provider, id: event.model.id }, thinking: pi.getThinkingLevel() };
    atomicWrite(identityPath(workerId), identity);
    audit("model_select", { model: identity.model, source: event.source });
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (!identity || shuttingDown) return;
    // Pi sets the new model before emitting a model-change clamp event.
    identity = { ...identity, model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
      thinking: pi.getThinkingLevel() };
    atomicWrite(identityPath(workerId), identity);
    audit("thinking_level_select", { model: identity.model, thinking: identity.thinking });
  });
  const guardWorkerConversation = () => {
    if (role !== "lead") return { cancel: true };
  };
  pi.on("session_before_switch", guardWorkerConversation);
  pi.on("session_before_fork", guardWorkerConversation);
  pi.on("session_before_tree", guardWorkerConversation);
  pi.on("input", (event) => {
    if (!identity || shuttingDown) return;
    if (!active) return;
    if (event.source !== "extension" || event.text !== `[ds-task ${active.nonce}]\n${active.task}`) return { action: "handled" };
    active = { ...active, phase: "input_observed" };
    atomicWrite(taskPath(active.submissionId), active);
    audit("input_observed", { nonce: active.nonce });
  });
  pi.on("before_agent_start", (event) => {
    if (!identity || shuttingDown) return;
    if (active && event.prompt === `[ds-task ${active.nonce}]\n${active.task}`) startNonce = active.nonce;
    event.systemPromptOptions.promptGuidelines.push("Host binding: ds-mode's Codex lead/worker references mean the corresponding native Pi roles here. Use matching update_plan, spawn_agent, wait_agent, list_agents, followup_task and interrupt_agent tools. Use read, grep, find and bash for Read/Grep/Glob/Shell. Preserve all skill phases, triggers, ownership and proof requirements. A genuine human question requires a real user answer; stop and report it if no interactive question tool is available.");
  });
  pi.on("tool_call", () => {
    if (shuttingDown && role !== "lead") return { block: true, reason: "Runtime shutting down" };
  });
  pi.on("agent_start", async (_event, ctx) => {
    context = ctx;
    if (!identity || shuttingDown) return;
    if (active && startNonce === active.nonce) {
      active = { ...active, phase: "started", selection: active.phase === "started" ? active.selection ?? null : {
        boundary: "agent_start", model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
        thinking: pi.getThinkingLevel(),
      } };
      atomicWrite(taskPath(active.submissionId), active);
      accepted?.();
      runSignal = ctx.signal;
      boundaryOutcome = undefined;
      audit("run_start", { nonce: active.nonce, signalCaptured: runSignal !== undefined });
    }
    await report("working");
  });
  pi.on("before_provider_request", () => { if (identity && !shuttingDown) audit("provider_request"); });
  pi.on("cache_warming_decision", () => {
    if (identity && !shuttingDown && role !== "lead") return { action: "stop" };
  });
  pi.on("message_end", (event) => {
    if (!identity || shuttingDown || event.message.role !== "assistant") return;
    audit("assistant_usage", { model: event.message.model, provider: event.message.provider, usage: event.message.usage, stopReason: event.message.stopReason });
    if (active) assistants.push(event.message);
  });
  pi.on("tool_execution_start", (event) => { if (identity && !shuttingDown) audit("tool_start", { toolName: event.toolName, toolCallId: event.toolCallId }); });
  pi.on("tool_execution_end", (event) => { if (identity && !shuttingDown) audit("tool_end", { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError }); });
  pi.on("agent_before_settle", (event) => {
    boundaryOutcome = event.outcome === "aborted" ? "interrupted" : event.outcome === "error" ? "error" : "completed";
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!identity || shuttingDown) return;
    context = ctx;
    if (active?.phase === "started") {
      const lastStopReason = assistants.at(-1)?.stopReason;
      const signalAborted = runSignal?.aborted === true;
      const outcome = signalAborted || lastStopReason === "aborted" ? "interrupted"
        : lastStopReason === "error" ? "error" : boundaryOutcome;
      audit("settlement_evidence", { idle: ctx.isIdle(), signalCaptured: runSignal !== undefined, signalAborted,
        lastStopReason: lastStopReason ?? null, boundaryOutcome: boundaryOutcome ?? null, outcome: outcome ?? null });
      if (!ctx.isIdle() || !outcome) {
        publish({ ...active, kind: "unavailable", reason: "Settlement lacked idle or outcome evidence" });
      } else {
        const finalText = assistants.map((message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).filter(Boolean).join("\n\n");
        const artifactPath = join(stateDir, "artifacts", `${workerId}-${active.submissionId}.md`);
        writeFileSync(artifactPath, finalText, { mode: 0o600 });
        publish({ ...active, kind: "settled", outcome, settledAt: new Date().toISOString(), finalText, artifactPath });
      }
    }
    await report("idle");
  });
  async function cleanup() {
    shuttingDown = true;
    if (!identity || shutdownCleaned) return;
    shutdownCleaned = true;
    await Promise.allSettled(launches);
    let detached = false;
    try {
      if (active) publish({ ...active, kind: "unavailable", reason: "Session shutdown before settlement" });
      atomicWrite(identityPath(workerId), { ...identity, available: false });
      detached = true;
      audit("session_shutdown");
      await reportQueue;
      await herdr(["pane", "release-agent", identity.paneId, "--source", "ds-slice", "--agent", "pi", "--seq", String(++sequence)]);
      audit("agent_released");
    } catch (error) { audit("release_error", { error: errorText(error) }); }
    finally {
      for (const socket of connections) socket.destroy();
      try { if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve())); }
      finally {
        rmSync(socketPath, { force: true });
        if (readIdentity(workerId).generation === generation) {
          rmSync(lockPath, { recursive: true, force: true });
          if (detached) atomicWrite(detachedPath, { generation });
        }
        context?.ui.setWidget("ds-plan", undefined);
      }
    }
  }

  async function proveDead(previous: Identity) {
    if (previous.herdrSession !== herdrSession || previous.workspaceId !== workspaceId) throw new Error("Restart workspace mismatch");
    if (previous.socketPath !== join(socketDir, `${previous.generation}.sock`)) throw new Error("Socket identity path mismatch");
    if (readIdentity(previous.workerId).generation !== previous.generation) throw new Error("Restart generation changed");
    if (isOriginalProcessLive(previous)) throw new Error("Original PID/birth still live; duplicate writer refused");
    if (await socketAlive(previous.socketPath)) throw new Error("Previous endpoint live or unknown; replacement refused");
    verifySession(previous);
  }
  function retireActive(previous: Identity, reason: string) {
    const directory = join(stateDir, "tasks", previous.workerId);
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const path = join(directory, file);
      const task = readRecord(TaskSchema, path);
      if (task.workerId !== previous.workerId || task.piSessionId !== previous.piSessionId) throw new Error("Task conversation mismatch");
      if (task.kind === "active") {
        if (task.generation !== previous.generation) throw new Error("Unreconciled active task from different generation");
        atomicWrite(path, { ...task, kind: "unavailable", reason });
      }
    }
  }
  async function submitTask(target: Identity, task: string, signal?: AbortSignal) {
    const submissionId = randomUUID();
    const receiptPath = join(stateDir, "operations", `${workerId}-${submissionId}.json`);
    const receipt = { workerId: target.workerId, generation: target.generation, submissionId, callerId: workerId, callerGeneration: generation };
    atomicWrite(receiptPath, { ...receipt, kind: "submitting" });
    try {
      const result = await call(target, { kind: "submit", submissionId, task }, signal);
      if (result.kind === "status" || result.workerId !== target.workerId || result.generation !== target.generation || result.submissionId !== submissionId)
        throw new Error("Submission receipt correlation mismatch");
      const selection = result.kind !== "ambiguous" && "selection" in result ? result.selection ?? null : null;
      const reported = { ...result, selection, identity: { ...target, model: selection?.model ?? null, thinking: selection?.thinking ?? null } };
      atomicWrite(receiptPath, { ...receipt, result: reported });
      return reported;
    } catch (error) {
      const result = { ...receipt, kind: "ambiguous" as const, reason: `${errorText(error)}; inspect ${receiptPath}; never replay`,
        selection: null, identity: { ...target, model: null, thinking: null } };
      atomicWrite(receiptPath, result);
      if (signal?.aborted) throw new Error(JSON.stringify(result));
      return result;
    }
  }
  function launch(...args: Parameters<typeof launchNative>) {
    const pending = launchNative(...args);
    launches.add(pending);
    void pending.finally(() => launches.delete(pending)).catch(() => {});
    return pending;
  }
  async function launchNative(spec: { childId: string; parent: string | null; childRole: Identity["role"]; childCwd: string;
    sessionPath: string; task: string } & ({ kind: "fresh"; selection: Selection } | { kind: "resume"; previous: Identity }), ctx: ExtensionContext, signal?: AbortSignal) {
    current();
    signal?.throwIfAborted();
    const previous = spec.kind === "resume" ? spec.previous : null;
    const selection = spec.kind === "fresh" ? spec.selection : selectWorker(ctx, {
      model: spec.previous.model, thinking: recordedThinking(spec.previous),
    });
    const { model, thinking } = selection;
    const launchId = randomUUID();
    const receiptPath = join(stateDir, "operations", `launch-${launchId}.json`);
    const base = { launchId, workerId: spec.childId, parentId: spec.parent, callerId: workerId, callerGeneration: generation,
      sessionPath: spec.sessionPath, previousGeneration: previous?.generation ?? null, workspaceId, herdrSession };
    const own = current();
    const claim = claimLaunch(stateDir, { launchId, workerId: spec.childId, previousGeneration: previous?.generation ?? null,
      piSessionPath: spec.sessionPath, ...selection, callerId: workerId, callerGeneration: generation, pid: own.pid, pidBirth: own.pidBirth });
    let pane: Pane | undefined;
    let nativeStartAttempted = false;
    let identityConfirmed = false;
    let cleanupProven = true;
    const save = (data: unknown) => atomicWrite(receiptPath, { ...base, claimPath: claim.path, ...selection, pane: pane ?? null, data });
    try {
      save({ kind: "creating" });
      if (previous) {
        await proveDead(previous);
        if (recordedThinking(previous) !== thinking) throw new Error("Recorded thinking changed under launch claim; continuation refused");
      }
      if (!previous) writeFileSync(spec.sessionPath, "", { flag: "wx", mode: 0o600 });
      const env = { ...config.childEnvironment, HERDR_SOCKET_PATH: config.herdrSocket, HERDR_SESSION_NAME: herdrSession,
        DS_HERDR_SOCKET_DIR: socketDir, DS_HERDR_STATE_DIR: stateDir, DS_HERDR_SESSION: herdrSession, DS_HERDR_WORKSPACE_ID: workspaceId,
        DS_HERDR_WORKER_ID: spec.childId, DS_HERDR_PARENT_ID: spec.parent ?? "", DS_HERDR_ROLE: spec.childRole,
        DS_HERDR_WORKSPACE: spec.childCwd, DS_HERDR_RESTART_GENERATION: previous?.generation ?? "", DS_HERDR_LAUNCH_ID: launchId };
      // Finish bounded creation even on caller abort so its exact receipt remains available for cleanup.
      cleanupProven = false;
      const created = await herdr(["tab", "create", "--workspace", workspaceId, "--cwd", spec.childCwd, "--label", `${spec.childRole}-${launchId.slice(0, 8)}`,
        ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--no-focus"]);
      save({ kind: "tab_response", response: created });
      pane = tabPane(created, workspaceId);
      save({ kind: "starting" });
      current();
      signal?.throwIfAborted();
      nativeStartAttempted = true;
      await herdr(["agent", "start", `${spec.childId}-${launchId.slice(0, 8)}`, "--kind", "pi", "--pane", pane.pane_id, "--timeout", "25000", "--",
        "--no-extensions", "-e", extensionPath, "--session", spec.sessionPath,
        "--model", `${model.provider}/${model.id}`,
        "--thinking", thinking, "--tools", normalTools.join(","), "--append-system-prompt", roleBrief(spec.childRole)]);
      signal?.throwIfAborted();
      const target = await live(owned(spec.childId), signal);
      if (target.paneId !== pane.pane_id || target.terminalId !== pane.terminal_id || target.piSessionPath !== spec.sessionPath ||
        target.model?.provider !== model.provider || target.model.id !== model.id || target.thinking !== thinking ||
        (previous && (target.generation === previous.generation || target.piSessionId !== previous.piSessionId))) throw new Error("Started worker identity, model or thinking mismatch");
      identityConfirmed = true;
      const result = await submitTask(target, spec.task, signal);
      if (result.kind === "unavailable") throw new Error(result.reason);
      signal?.throwIfAborted();
      save({ kind: "submitted", identity: result.identity, result });
      return result;
    } catch (error) {
      let cleanup = cleanupProven ? "no pane/process creation attempted" : "uncertain: no exact created pane receipt; inspect operation and private workspace";
      if (pane) {
        try {
          const found = parse(PaneResponse, await herdr(["pane", "get", pane.pane_id])).result.pane;
          if (found.terminal_id !== pane.terminal_id || found.workspace_id !== workspaceId || found.tab_id !== pane.tab_id) throw new Error("Pane identity changed; cleanup refused");
          await herdr(["pane", "close", pane.pane_id]);
          cleanupProven = !nativeStartAttempted;
          if (existsSync(identityPath(spec.childId))) {
            const target = readIdentity(spec.childId);
            if (target.paneId === pane.pane_id && target.terminalId === pane.terminal_id) {
              for (let n = 0; n < 20 && isOriginalProcessLive(target); n++) await new Promise((resolve) => setTimeout(resolve, 100));
              await proveDead(target);
              retireActive(target, "Launch failed/cancelled and exact new worker process ended; never replayed");
              atomicWrite(identityPath(target.workerId), { ...target, available: false });
              cleanupProven = true;
            }
          }
          cleanup = cleanupProven ? "exact newly-created pane closed; process cleanup proven"
            : "exact newly-created pane closed; native process identity unconfirmed, launch claim retained";
        } catch (cleanupError) { cleanup = `uncertain: ${errorText(cleanupError)}`; }
      }
      save({ kind: "failed", error: errorText(error), cleanup });
      throw new Error(`Launch ${spec.childId} failed: ${errorText(error)}. Cleanup ${cleanup}. Durable receipt ${receiptPath}`);
    } finally {
      if (identityConfirmed || cleanupProven) claim.release();
    }
  }
  function toolResult(value: unknown) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 50000) {
      const path = join(stateDir, "artifacts", `${workerId}-tool-${randomUUID()}.json`);
      writeFileSync(path, text, { mode: 0o600 });
      return { content: [{ type: "text" as const, text: JSON.stringify({ truncated: true, artifactPath: path }) }], details: {} };
    }
    return { content: [{ type: "text" as const, text }], details: {} };
  }
  function registerTools() {
  pi.registerTool({
    name: "update_plan", label: "Update plan", description: "Replace this session's own checklist. Preserve exact step text, including verbatim playbook steps. Workers cannot target another session's plan.",
    parameters: PlanSchema,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const plan = { ...params, workerId, piSessionId: current().piSessionId };
      atomicWrite(join(stateDir, "plans", `${workerId}.json`), plan);
      pi.appendEntry("ds-plan", plan);
      if (ctx.hasUI) ctx.ui.setWidget("ds-plan", planLines(plan));
      return toolResult(plan);
    },
  });
  pi.registerTool({
    name: "spawn_agent", label: "Spawn agent", description: "Start a fresh native Pi child in its own visible tab. Supply the complete brief with role, contract, writable paths, exclusions, verification, edit permission and report shape. No inherited parent history. All roles have normal tools. Model is optional and inherits the caller's model when omitted. Supply thinking explicitly on every spawn; role does not set its level. Unsupported thinking is rejected before allocation. Receipt identity reports model and thinking observed at the first correlated agent_start, or null when unknown. Record workerId and submissionId; ambiguous is not completion.",
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 200000 }), role: StringEnum(["implement", "explore", "review", "judgment"] as const),
      fork_turns: Type.Optional(StringEnum(["none"])), cwd: Type.Optional(Type.String()),
      model: Type.Optional(ModelSchema), thinking: ThinkingSchema }),
    async execute(_id, params, signal, _update, ctx) {
      const selection = selectWorker(ctx, { model: params.model ?? ctx.model ?? null, thinking: params.thinking });
      const childId = `w${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      return toolResult(await launch({ kind: "fresh", selection, childId, parent: workerId, childRole: params.role, childCwd: resolve(ctx.cwd, params.cwd ?? ctx.cwd),
        sessionPath: join(stateDir, "sessions", `${childId}.jsonl`), task: params.task }, ctx, signal));
    },
  });
  pi.registerTool({
    name: "list_agents", label: "List agents", description: "List this caller's descendants with exact runtime status. Registry alone does not prove liveness. Output capped at 50 KiB with artifact path.", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      current();
      const rows: unknown[] = [];
      for (const file of readdirSync(join(stateDir, "workers"))) {
        if (!file.endsWith(".json")) continue;
        const target = readIdentity(file.slice(0, -5));
        if (!isDescendant(target.workerId, workerId)) continue;
        try {
          await live(target, signal);
          const status = await request(target.socketPath, { kind: "status", callerId: workerId, callerGeneration: current().generation, generation: target.generation }, signal);
          rows.push(status);
        } catch (error) { rows.push({ kind: "unavailable", identity: target, error: errorText(error) }); }
      }
      return toolResult(rows);
    },
  });
  pi.registerTool({
    name: "wait_agent", label: "Wait for agent", description: "Wait for one exact submission to settle. Timeout leaves the worker active. Final text capped at 45 KiB with full artifact path; interrupted/error are distinct outcomes.",
    parameters: Type.Object({ ...targetFields, timeout_ms: Type.Integer({ minimum: 120000, maximum: 600000 }) }),
    async execute(_id, params, signal) {
      return toolResult(await call(owned(params.agent_id), { kind: "wait", submissionId: params.submission_id, timeoutMs: params.timeout_ms }, signal));
    },
  });
  pi.registerTool({
    name: "followup_task", label: "Follow-up task", description: "Submit only a new task to the original descendant's Pi conversation. Revive a proven dead worker in a new tab with the same worker ID/session UUID and new runtime generation. Never replay interrupted work. Retains the worker's native model and thinking. Receipt identity reports selection observed at the first correlated agent_start, or null when unknown. Live busy or unreachable writers are refused. Record the new submissionId.",
    parameters: Type.Object({ agent_id: idSchema, task: Type.String({ minLength: 1, maxLength: 200000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const target = owned(params.agent_id);
      if (isOriginalProcessLive(target)) {
        const effective = await live(target, signal);
        return toolResult(await submitTask(effective, params.task, signal));
      }
      await proveDead(target);
      return toolResult(await launch({ kind: "resume", childId: target.workerId, parent: target.parentId, childRole: target.role, childCwd: target.cwd,
        sessionPath: target.piSessionPath, task: params.task, previous: target }, ctx, signal));
    },
  });
  pi.registerTool({
    name: "interrupt_agent", label: "Interrupt agent", description: "Abort one exact descendant task and wait up to 120 seconds. For ambiguous preflight, request native shutdown and prove original process death instead; result is unavailable, not fabricated interruption. If death remains unconfirmed, followup refuses revival. Never replay the old task.",
    parameters: Type.Object(targetFields),
    async execute(_id, params, signal) {
      const target = owned(params.agent_id);
      const result = await call(target, { kind: "interrupt", submissionId: params.submission_id, timeoutMs: 120000 }, signal);
      if (result.kind !== "reset_requested") return toolResult(result);
      const deadline = Date.now() + 120000;
      while (isOriginalProcessLive(target) && Date.now() < deadline) {
        signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (isOriginalProcessLive(target)) return toolResult({ ...result, reason: "Shutdown requested but process death unconfirmed after 120 seconds. Operator inspection required; followup will refuse a duplicate writer." });
      await proveDead(target);
      return toolResult(readRecord(TaskSchema, join(stateDir, "tasks", target.workerId, `${params.submission_id}.json`)));
    },
  });
  if (role !== "lead") pi.setActiveTools(normalTools);
  pi.registerCommand("herdr-agents", {
    description: "Show this adapter's identity, state directory, and enabled tools",
    handler: async (_args, ctx) => {
      const own = current();
      const enabled = pi.getActiveTools().filter(name => toolNames.includes(name));
      ctx.ui.notify(`Herdr agents: ${own.workerId}, session ${own.piSessionId}\nState: ${stateDir}\nEnabled: ${enabled.join(", ") || "none"}`, "info");
    },
  });
  audit("session_start", { ...current(), activeTools: pi.getActiveTools(), thinking: pi.getThinkingLevel() });
  }
  return { startup, cleanup, registerTools };
}
