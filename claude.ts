import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { atomicWrite, errorText, parse, readRecord, Role, SafeId } from "./protocol.ts";
import { privateDirectory } from "./startup.ts";
import { roleBrief, tabPane, type Pane } from "./runtime.ts";

// Claude Code workers cannot host this adapter, so the caller owns their whole state. They are one-shot leaf workers.
export const ClaudeEffort = StringEnum(["low", "medium", "high", "xhigh", "max"] as const);
export const ClaudeModel = Type.String({ pattern: "^[a-zA-Z0-9._-]{1,64}$" });
export const defaultClaudeModel = "claude-opus-5-5";
const hookScript = fileURLToPath(new URL("./claude-hook.sh", import.meta.url));
const hookEvents = ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"] as const;
type HookEvent = (typeof hookEvents)[number];
const hookFile = /^(UserPromptSubmit|Stop|StopFailure|SessionEnd)-\d+-\d+\.json$/;
// Linux caps one argv string at 128 KiB; larger briefs go through a file the worker reads first.
const argumentLimit = 120_000;
// Herdr may type the launch line before the shell leaves canonical mode; macOS truncates canonical input at 1024 bytes.
const typedLimit = 1024;
// Claude's own delegation and question tools would create hidden workers or wait for a human nobody watches.
const leafDisallowedTools = "Agent,Task,AskUserQuestion";

const ClaudeTaskSchema = Type.Object({
  submissionId: SafeId, kind: StringEnum(["active", "settled", "unavailable"] as const),
  outcome: Type.Union([StringEnum(["completed", "interrupted", "error"] as const), Type.Null()]),
  finalText: Type.String(), artifactPath: Type.Union([Type.String(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]),
  claudeSessionId: Type.Union([Type.String(), Type.Null()]), transcriptPath: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.String(),
});
export const ClaudeWorkerSchema = Type.Object({
  workerId: SafeId, parentId: SafeId, role: Role, runtime: Type.Literal("claude"), model: ClaudeModel, effort: ClaudeEffort,
  cwd: Type.String(), workspaceId: Type.String(), tabId: Type.String(), paneId: Type.String(), terminalId: Type.String(),
  launchId: SafeId, state: StringEnum(["open", "closed"] as const), task: ClaudeTaskSchema,
  // Set before an interrupt closes the pane: a vanished pane with this intent is an interruption, not a lost pane,
  // whether the interrupter finishes or dies between closing and recording.
  interrupting: Type.Optional(Type.Boolean()),
});
export type ClaudeWorker = Static<typeof ClaudeWorkerSchema>;
type ClaudeTask = ClaudeWorker["task"];
const LaunchReceiptSchema = Type.Object({
  launchId: SafeId, workerId: SafeId, parentId: SafeId, kind: StringEnum(["creating", "created", "started", "failed"] as const),
  response: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()), cleanup: Type.Optional(Type.String()),
});

export type ClaudeHost = {
  stateDir: string; workerId: string; workspaceId: string;
  claudeCommand: string;
  // Throws once the owning runtime has detached, so a late wait or listing never writes for a stale runtime.
  admit(): void;
  herdr(args: string[], signal?: AbortSignal): Promise<unknown>;
  readPane(paneId: string): Promise<string>;
  audit(event: string, data?: unknown): void;
};

const workerDir = (stateDir: string, id: string) => join(stateDir, "claude", parse(SafeId, id));
const recordPath = (stateDir: string, id: string) => join(workerDir(stateDir, id), "worker.json");
const receiptPath = (stateDir: string, id: string) => join(workerDir(stateDir, id), "launch.json");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const text = (value: unknown) => (typeof value === "string" ? value : null);

// Resolve from the lead's PATH: the Herdr pane environment need not contain it. PI_HERDR_CLAUDE_BIN overrides.
export function claudeCommand(env: { PATH?: string; PI_HERDR_CLAUDE_BIN?: string }): string {
  if (env.PI_HERDR_CLAUDE_BIN) {
    if (!isAbsolute(env.PI_HERDR_CLAUDE_BIN)) throw new Error("PI_HERDR_CLAUDE_BIN must be absolute");
    return env.PI_HERDR_CLAUDE_BIN;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    const candidate = join(dir, "claude");
    if (isAbsolute(dir) && existsSync(candidate)) try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("Claude Code executable not found on PATH; install it or set PI_HERDR_CLAUDE_BIN");
}
export function isClaudeWorker(stateDir: string, id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) && existsSync(recordPath(stateDir, id));
}
export function readClaudeWorker(stateDir: string, id: string): ClaudeWorker {
  return readRecord(ClaudeWorkerSchema, recordPath(stateDir, id));
}
function claudeIds(stateDir: string): string[] {
  const root = join(stateDir, "claude");
  return existsSync(root) ? readdirSync(root).filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id)) : [];
}

// Every state transition runs under one per-worker lock so concurrent callers cannot overwrite a settled result.
function withLock<T>(stateDir: string, id: string, fn: () => T): T {
  const lock = join(workerDir(stateDir, id), "lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() > deadline) throw new Error(`Claude worker ${id} state is locked; inspect ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

type HookRecord = { event: HookEvent; input: Record<string, unknown> };
// Hooks write one immutable file per invocation; order by write time so the first terminal event wins.
function hookRecords(stateDir: string, id: string): HookRecord[] {
  const dir = join(workerDir(stateDir, id), "hooks");
  return readdirSync(dir).filter((name) => hookFile.test(name))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    .map(({ name }) => {
      const input: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!input || typeof input !== "object") throw new Error(`Malformed Claude hook evidence ${name}`);
      return { event: name.slice(0, name.indexOf("-")) as HookEvent, input: input as Record<string, unknown> };
    });
}
function evidence(stateDir: string, id: string) {
  const records = hookRecords(stateDir, id);
  const accepted = records.find((record) => record.event === "UserPromptSubmit")?.input;
  const session = accepted ? text(accepted.session_id) : null;
  // Session identity, not file order, ties a result to the task: equal write times can sort a Stop before its prompt.
  const terminal = records.find((record) => record.event !== "UserPromptSubmit" && (!accepted || text(record.input.session_id) === session));
  return { accepted, terminal };
}

function settled(host: ClaudeHost, worker: ClaudeWorker, task: Partial<ClaudeTask>): ClaudeWorker {
  if (task.reason) task = { ...task, reason: task.reason.slice(0, 4000) };
  let artifactPath: string | null = null;
  if (task.finalText) {
    artifactPath = join(host.stateDir, "artifacts", `${worker.workerId}-${worker.task.submissionId}.md`);
    writeFileSync(artifactPath, task.finalText, { mode: 0o600 });
  }
  host.audit("claude_settlement", { claudeWorkerId: worker.workerId, kind: task.kind, outcome: task.outcome ?? null });
  return { ...worker, task: { ...worker.task, ...task, artifactPath } };
}
function fromEvidence(host: ClaudeHost, worker: ClaudeWorker): ClaudeWorker | undefined {
  const { terminal } = evidence(host.stateDir, worker.workerId);
  if (!terminal) return undefined;
  const input = terminal.input;
  if (terminal.event === "Stop") return settled(host, worker, { kind: "settled", outcome: "completed",
    finalText: text(input.last_assistant_message) ?? "", transcriptPath: text(input.transcript_path) ?? worker.task.transcriptPath });
  if (terminal.event === "StopFailure") return settled(host, worker, { kind: "settled", outcome: "error",
    finalText: text(input.last_assistant_message) ?? "", reason: text(input.error) ?? JSON.stringify(input).slice(0, 2000) });
  return settled(host, worker, { kind: "unavailable", reason: `Claude session ended without a result (${text(input.reason) ?? "unknown"})` });
}
function transition(host: ClaudeHost, id: string, update: (worker: ClaudeWorker) => ClaudeWorker | undefined): ClaudeWorker {
  host.admit();
  return withLock(host.stateDir, id, () => {
    host.admit();
    const worker = readClaudeWorker(host.stateDir, id);
    const next = update(worker);
    if (next) atomicWrite(recordPath(host.stateDir, id), next);
    return next ?? worker;
  });
}
function observe(host: ClaudeHost, id: string): ClaudeWorker {
  return transition(host, id, (worker) => worker.task.kind === "active" ? fromEvidence(host, worker) : undefined);
}

const PaneList = Type.Object({ result: Type.Object({ panes: Type.Array(Type.Object({ pane_id: Type.String(), terminal_id: Type.String(),
  workspace_id: Type.String(), tab_id: Type.String() })) }) });
type PaneIdentity = Pick<ClaudeWorker, "paneId" | "terminalId" | "workspaceId" | "tabId">;
// The launch execs Claude as the pane's only process, so the pane's terminal lives exactly as long as Claude does.
// Absence needs a server-wide listing: Herdr gives a moved pane a new ID, so a missing old ID proves nothing.
async function paneState(host: ClaudeHost, pane: PaneIdentity) {
  const panes = parse(PaneList, await host.herdr(["pane", "list"])).result.panes;
  const matches = panes.filter((found) => found.pane_id === pane.paneId || found.terminal_id === pane.terminalId);
  if (!matches.length) return "absent" as const;
  const [found] = matches;
  return matches.length === 1 && found!.pane_id === pane.paneId && found!.terminal_id === pane.terminalId &&
    found!.workspace_id === pane.workspaceId && found!.tab_id === pane.tabId ? "present" as const : "changed" as const;
}
// Close only the exact pane this caller created, never its whole tab, then prove it is gone.
async function closeExactPane(host: ClaudeHost, pane: PaneIdentity) {
  const before = await paneState(host, pane);
  if (before === "absent") return;
  if (before === "changed") throw new Error("Claude pane moved or identity changed; close refused");
  await host.herdr(["pane", "close", pane.paneId]);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await paneState(host, pane) === "absent") return;
    await sleep(100);
  }
  throw new Error("Claude pane still present after close");
}
// A task whose pane vanished without terminal evidence is interrupted when an interrupt was recorded, otherwise unavailable.
async function reconcile(host: ClaudeHost, id: string): Promise<ClaudeWorker> {
  const worker = observe(host, id);
  if (worker.task.kind !== "active" || worker.state !== "open" || await paneState(host, worker) !== "absent") return worker;
  return transition(host, id, (current) => current.task.kind !== "active" ? undefined : closedWithoutResult(host, current));
}
function closedWithoutResult(host: ClaudeHost, worker: ClaudeWorker): ClaudeWorker {
  const closed = { ...worker, state: "closed" as const, interrupting: false };
  return fromEvidence(host, closed) ?? (worker.interrupting
    ? settled(host, closed, { kind: "settled", outcome: "interrupted", reason: "Pane closed by interrupt_agent" })
    : settled(host, closed, { kind: "unavailable", reason: "Claude pane closed without a result" }));
}

export function publicClaudeTask(worker: ClaudeWorker) {
  const task = { ...worker.task };
  while (Buffer.byteLength(JSON.stringify(task)) > 45000 && task.finalText) task.finalText = task.finalText.slice(0, Math.floor(task.finalText.length * 0.8));
  return { runtime: "claude" as const, workerId: worker.workerId, model: worker.model, effort: worker.effort, ...task };
}

export async function spawnClaude(host: ClaudeHost, spec: { role: Static<typeof Role>; cwd: string; task: string; model: string;
  effort: Static<typeof ClaudeEffort> }, signal?: AbortSignal, startupTimeoutMs = 60000) {
  const model = parse(ClaudeModel, spec.model);
  const effort = parse(ClaudeEffort, spec.effort);
  const workerId = `c${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const submissionId = randomUUID();
  const launchId = randomUUID();
  const dir = workerDir(host.stateDir, workerId);
  const launcher = join(dir, "launch.sh");
  const typed = `exec ${quote(launcher)}`;
  if (Buffer.byteLength(typed) >= typedLimit) throw new Error(`Claude launch line too long (${Buffer.byteLength(typed)} of ${typedLimit - 1} bytes); shorten XDG_STATE_HOME`);
  privateDirectory(join(dir, "hooks"));
  const brief = join(dir, "brief.md");
  writeFileSync(brief, spec.task, { mode: 0o600 });
  const hooks = Object.fromEntries(hookEvents.map((event) => [event, [{ hooks: [{ type: "command",
    command: ["/bin/sh", hookScript, event, join(dir, "hooks")].map(quote).join(" ") }] }]]));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks }), { mode: 0o600 });
  const prompt = Buffer.byteLength(spec.task) > argumentLimit
    ? quote(`Your complete task brief is in ${brief}. Read all of it first, then follow it exactly.`)
    : `"$(cat ${quote(brief)})"`;
  const system = `${roleBrief(spec.role)} You cannot start other agents; do the work yourself.`;
  // `--` ends option parsing, so a brief that starts with "-" stays task text.
  writeFileSync(launcher, ["#!/bin/sh",
    // Clear API credentials and third-party provider routing so the session uses the Claude login.
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY",
    `exec ${quote(host.claudeCommand)} --setting-sources '' --settings ${quote(join(dir, "settings.json"))} --strict-mcp-config ` +
      `--disallowed-tools ${quote(leafDisallowedTools)} --append-system-prompt ${quote(system)} --add-dir ${quote(dir)} ` +
      `--permission-mode bypassPermissions --model ${quote(model)} --effort ${quote(effort)} -- ${prompt}`, ""].join("\n"), { mode: 0o700 });
  const receipt = (kind: Static<typeof LaunchReceiptSchema>["kind"], extra: Partial<Static<typeof LaunchReceiptSchema>> = {}) =>
    atomicWrite(receiptPath(host.stateDir, workerId), { launchId, workerId, parentId: host.workerId, kind, ...extra });
  receipt("creating");
  let pane: Pane | undefined;
  let created: unknown;
  try {
    // Finish bounded creation even on caller abort so the exact tab is known for cleanup.
    created = await host.herdr(["tab", "create", "--workspace", host.workspaceId, "--cwd", spec.cwd,
      "--label", `claude-${spec.role}-${launchId.slice(0, 8)}`, "--no-focus"]);
    receipt("created", { response: created });
    pane = tabPane(created, host.workspaceId);
    atomicWrite(recordPath(host.stateDir, workerId), { workerId, parentId: host.workerId, role: spec.role, runtime: "claude", model,
      effort, cwd: spec.cwd, workspaceId: host.workspaceId, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id,
      launchId, state: "open", task: { submissionId, kind: "active", outcome: null, finalText: "", artifactPath: null, reason: null,
        claudeSessionId: null, transcriptPath: null, startedAt: new Date().toISOString() } } satisfies ClaudeWorker);
    host.audit("claude_launch", { claudeWorkerId: workerId, paneId: pane.pane_id, model, effort });
    signal?.throwIfAborted();
    await host.herdr(["pane", "run", pane.pane_id, typed]);
    const deadline = Date.now() + startupTimeoutMs;
    const untrusted = () => new Error(`Claude Code does not trust ${spec.cwd}'s repository. Open claude there once, trust it, then retry`);
    let accepted = evidence(host.stateDir, workerId).accepted;
    for (let poll = 1; !accepted && Date.now() < deadline; poll++) {
      signal?.throwIfAborted();
      if (evidence(host.stateDir, workerId).terminal) break;
      // The trust dialog never submits the prompt; detect it on the visible screen instead of waiting out the deadline.
      if (poll % 10 === 0 && /trust this folder/i.test(await host.readPane(pane.pane_id).catch(() => ""))) throw untrusted();
      await sleep(500);
      accepted = evidence(host.stateDir, workerId).accepted;
    }
    if (!accepted) {
      const screen = await host.readPane(pane.pane_id).catch(() => "");
      if (/trust this folder/i.test(screen)) throw untrusted();
      throw new Error(`Claude worker did not accept its task within ${startupTimeoutMs} ms. Pane excerpt: ${screen.trim().slice(-800)}`);
    }
    const session = { claudeSessionId: text(accepted.session_id), transcriptPath: text(accepted.transcript_path) };
    transition(host, workerId, (worker) => ({ ...worker, task: { ...worker.task, ...session } }));
    receipt("started");
    return { kind: "accepted" as const, evidence: "user_prompt_submit" as const, runtime: "claude" as const, workerId, submissionId,
      identity: { workerId, parentId: host.workerId, role: spec.role, paneId: pane.pane_id, model, effort } };
  } catch (error) {
    let cleanup: string;
    if (pane) {
      const exact = { paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id };
      cleanup = await closeExactPane(host, exact).then(() => "exact new pane closed", (closeError) => `uncertain: ${errorText(closeError)}`);
      // The failure receipt must survive even when recording the worker outcome fails.
      try {
        if (existsSync(recordPath(host.stateDir, workerId))) transition(host, workerId, (worker) => worker.task.kind !== "active" ? undefined :
          settled(host, { ...worker, state: cleanup === "exact new pane closed" ? "closed" : "open" }, { kind: "unavailable", reason: errorText(error) }));
      } catch (recordError) { cleanup += `; worker record not updated: ${errorText(recordError)}`; }
    } else {
      cleanup = created === undefined ? "uncertain: tab creation outcome unknown; inspect the launch receipt" : "uncertain: created tab response unusable";
    }
    receipt("failed", { response: created, error: errorText(error), cleanup });
    throw new Error(`Claude launch ${workerId} failed: ${errorText(error)}. Cleanup ${cleanup}. Receipt ${receiptPath(host.stateDir, workerId)}`);
  }
}

export async function waitClaude(host: ClaudeHost, id: string, submissionId: string, timeoutMs: number, signal?: AbortSignal) {
  if (readClaudeWorker(host.stateDir, id).task.submissionId !== submissionId) throw new Error("Unknown submission for this Claude worker");
  const deadline = Date.now() + timeoutMs;
  let worker = await reconcile(host, id);
  for (let poll = 1; worker.task.kind === "active" && Date.now() < deadline; poll++) {
    await sleep(1000);
    signal?.throwIfAborted();
    worker = poll % 10 === 0 ? await reconcile(host, id) : observe(host, id);
  }
  if (worker.task.kind === "active") return { kind: "timeout" as const, runtime: "claude" as const, workerId: id, submissionId, active: true };
  return publicClaudeTask(worker);
}

export async function interruptClaude(host: ClaudeHost, id: string, submissionId: string) {
  const worker = await reconcile(host, id);
  if (worker.task.submissionId !== submissionId) throw new Error("Unknown submission for this Claude worker");
  if (worker.task.kind !== "active") return publicClaudeTask(worker);
  const marked = transition(host, id, (current) => current.task.kind === "active" ? { ...current, interrupting: true } : undefined);
  if (marked.task.kind !== "active") return publicClaudeTask(marked);
  try {
    await closeExactPane(host, marked);
  } catch (error) {
    transition(host, id, (current) => ({ ...current, interrupting: false }));
    throw error;
  }
  // Evidence that landed before the close wins over the interruption.
  return publicClaudeTask(transition(host, id, (current) =>
    current.task.kind !== "active" ? { ...current, state: "closed", interrupting: false } : closedWithoutResult(host, current)));
}

export async function retireClaude(host: ClaudeHost, id: string) {
  let worker = await reconcile(host, id);
  if (worker.task.kind === "active") throw new Error("Claude worker has an active task; wait or interrupt before retiring");
  if (worker.state === "open") {
    await closeExactPane(host, worker);
    worker = transition(host, id, (current) => ({ ...current, state: "closed" }));
  }
  host.audit("claude_retired", { claudeWorkerId: id });
  return { kind: "retirement" as const, runtime: "claude" as const, workerId: id, state: "retired" as const, paneClosed: true,
    transcriptPath: worker.task.transcriptPath, artifactPath: worker.task.artifactPath };
}

export async function listClaude(host: ClaudeHost, isOwned: (parentId: string) => boolean) {
  const rows = [];
  for (const id of claudeIds(host.stateDir)) {
    if (!existsSync(recordPath(host.stateDir, id)) || !isOwned(readClaudeWorker(host.stateDir, id).parentId)) continue;
    try {
      const worker = await reconcile(host, id);
      rows.push({ kind: "claude_status" as const, runtime: "claude" as const, workerId: id, state: worker.state, parentId: worker.parentId,
        role: worker.role, paneId: worker.paneId, model: worker.model, effort: worker.effort, task: { ...publicClaudeTask(worker), finalText: "" } });
    } catch (error) { rows.push({ kind: "unavailable" as const, runtime: "claude" as const, workerId: id, error: errorText(error) }); }
  }
  return rows;
}

// A caller may not retire while it owns an open Claude pane, an active task, or a launch not proven clean.
export function unresolvedClaudeChild(stateDir: string, isUnder: (parentId: string) => boolean): string | undefined {
  for (const id of claudeIds(stateDir)) {
    const receipt = existsSync(receiptPath(stateDir, id)) ? readRecord(LaunchReceiptSchema, receiptPath(stateDir, id)) : undefined;
    const parentId = receipt?.parentId ?? (existsSync(recordPath(stateDir, id)) ? readClaudeWorker(stateDir, id).parentId : undefined);
    if (!parentId || !isUnder(parentId)) continue;
    if (!existsSync(recordPath(stateDir, id))) {
      if (receipt?.kind !== "failed" || receipt.cleanup?.startsWith("uncertain")) return id;
      continue;
    }
    const worker = readClaudeWorker(stateDir, id);
    if (worker.state === "open" || worker.task.kind === "active") return id;
  }
  return undefined;
}
