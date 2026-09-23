import { createConnection } from "node:net";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";

export const SafeId = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" });
export const Role = Type.Union([Type.Literal("lead"), Type.Literal("implement"), Type.Literal("explore"), Type.Literal("review"), Type.Literal("judgment")]);
export const ModelSchema = Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) });
export const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export const SelectionSchema = Type.Object({ model: ModelSchema, thinking: ThinkingSchema });
export type Selection = Static<typeof SelectionSchema>;
export const IdentitySchema = Type.Object({
  workerId: SafeId, parentId: Type.Union([SafeId, Type.Null()]), role: Role,
  herdrSession: Type.String(), workspaceId: Type.String(), paneId: Type.String(), terminalId: Type.String(), generation: SafeId,
  socketPath: Type.String(), pid: Type.Integer({ minimum: 1 }), pidBirth: Type.String({ minLength: 1 }), piSessionId: Type.String(),
  piSessionPath: Type.String(), cwd: Type.String(), available: Type.Boolean(), model: Type.Union([ModelSchema, Type.Null()]),
  thinking: Type.Union([ThinkingSchema, Type.Null()]),
});
export type Identity = Static<typeof IdentitySchema>;
// Only the old, absent field maps to unknown. Malformed recorded levels still fail closed.
const StoredIdentitySchema = Type.Union([IdentitySchema, Type.Object({
  ...Type.Omit(IdentitySchema, ["thinking"]).properties, thinking: Type.Optional(Type.Never()),
})]);
export function parseIdentity(input: unknown): Identity {
  const stored = parse(StoredIdentitySchema, input);
  return { ...stored, thinking: stored.thinking ?? null };
}
export function readIdentityRecord(path: string): Identity {
  return parseIdentity(JSON.parse(readFileSync(path, "utf8")));
}
const correlation = { workerId: SafeId, generation: SafeId, submissionId: SafeId };
const taskSelection = { selection: Type.Optional(Type.Union([Type.Object({
  boundary: Type.Literal("agent_start"),
  model: IdentitySchema.properties.model, thinking: IdentitySchema.properties.thinking,
}), Type.Null()])) };
const taskBase = { ...correlation, ...taskSelection, piSessionId: Type.String(), task: Type.String(), startedAt: Type.String() };
export const TaskSchema = Type.Union([
  Type.Object({ ...taskBase, kind: Type.Literal("active"), phase: Type.Union([
    Type.Literal("pending"), Type.Literal("input_observed"), Type.Literal("started"), Type.Literal("ambiguous"),
  ]), nonce: SafeId }),
  Type.Object({ ...taskBase, kind: Type.Literal("settled"), outcome: Type.Union([
    Type.Literal("completed"), Type.Literal("interrupted"), Type.Literal("error"),
  ]), settledAt: Type.String(), finalText: Type.String(), artifactPath: Type.String() }),
  Type.Object({ ...taskBase, kind: Type.Literal("unavailable"), reason: Type.String() }),
]);
export type Task = Static<typeof TaskSchema>;
const requestBase = { callerId: SafeId, callerGeneration: SafeId, generation: SafeId };
const waitFields = { submissionId: SafeId, timeoutMs: Type.Integer({ minimum: 1, maximum: 600000 }) };
export const RequestSchema = Type.Union([
  Type.Object({ ...requestBase, kind: Type.Literal("status") }),
  Type.Object({ ...requestBase, kind: Type.Literal("submit"), submissionId: SafeId, task: Type.String({ minLength: 1, maxLength: 200000 }) }),
  Type.Object({ ...requestBase, ...waitFields, kind: Type.Literal("wait") }),
  Type.Object({ ...requestBase, ...waitFields, kind: Type.Literal("interrupt") }),
  Type.Object({ ...requestBase, kind: Type.Literal("reset_pending"), submissionId: SafeId }),
  Type.Object({ ...requestBase, kind: Type.Literal("retire") }),
]);
export type Request = Static<typeof RequestSchema>;
export const ResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("status"), identity: StoredIdentitySchema, active: Type.Union([TaskSchema, Type.Null()]), idle: Type.Boolean(), queued: Type.Optional(Type.Boolean()), launching: Type.Optional(Type.Boolean()) }),
  Type.Object({ kind: Type.Literal("accepted"), ...correlation, ...taskSelection, evidence: Type.Literal("agent_start") }),
  Type.Object({ kind: Type.Literal("ambiguous"), ...correlation, ...taskSelection, reason: Type.String() }),
  Type.Object({ kind: Type.Literal("reset_requested"), ...correlation, reason: Type.String() }),
  Type.Object({ kind: Type.Literal("retire_requested"), workerId: SafeId, generation: SafeId }),
  Type.Object({ kind: Type.Literal("timeout"), ...correlation, active: Type.Literal(true) }),
  TaskSchema,
]);
type WireResult = Static<typeof ResultSchema>;
export type Result = Exclude<WireResult, { kind: "status" }> | (Omit<Extract<WireResult, { kind: "status" }>, "identity"> & { identity: Identity });
const ResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), result: ResultSchema }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);
export function parse<T extends TSchema>(schema: T, input: unknown): Static<T> {
  if (!Check(schema, input)) throw new Error("Invalid protocol or persisted record");
  return input;
}
export function readRecord<T extends TSchema>(schema: T, path: string): Static<T> {
  return parse(schema, JSON.parse(readFileSync(path, "utf8")));
}
export function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function request(socketPath: string, message: Request, signal?: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let done = false;
    const timeout = setTimeout(() => finish(new Error("Socket deadline; submit acceptance may be ambiguous, do not retry")),
      (message.kind === "wait" || message.kind === "interrupt" ? message.timeoutMs : 30000) + 2000);
    const abort = () => finish(new Error("Caller cancelled; target unchanged unless interrupt was already accepted"));
    function finish(error?: Error, result?: Result) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Socket closed before response; submit acceptance may be ambiguous")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return finish(new Error("Oversize response"));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = parse(ResponseSchema, JSON.parse(buffer.slice(0, end)));
        if (!response.ok) finish(new Error(response.error));
        else finish(undefined, response.result.kind === "status"
          ? { ...response.result, identity: parseIdentity(response.result.identity) } : response.result);
      } catch (error) { finish(new Error(errorText(error))); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let done = false;
    const timer = setTimeout(() => finish(true), 1000); // Unknown is not safe to replace.
    function finish(alive: boolean) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    }
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ENOENT" && error.code !== "ECONNREFUSED"));
  });
}
