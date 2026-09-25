import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { buildSessionContext, parseSessionEntries, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atomicWrite, SelectionSchema, ThinkingSchema, parse, readIdentityRecord, readRecord, SafeId, type Identity, type Selection } from "./protocol.ts";

export const LaunchClaimSchema = Type.Object({
  launchId: SafeId, workerId: SafeId, previousGeneration: Type.Union([SafeId, Type.Null()]),
  piSessionPath: Type.String(), ...SelectionSchema.properties, callerId: SafeId, callerGeneration: SafeId,
  pid: Type.Integer({ minimum: 1 }), pidBirth: Type.String({ minLength: 1 }),
});
export function retirementFence(stateDir: string, workerId: string): string {
  return join(stateDir, "locks", `retire-${parse(SafeId, workerId)}`);
}
export function assertNoRetirement(stateDir: string, workerId: string): void {
  const visited = new Set<string>();
  let next: string | null = workerId;
  while (next) {
    if (visited.has(next)) throw new Error("Worker parent cycle");
    visited.add(next);
    if (existsSync(retirementFence(stateDir, next))) throw new Error(`Retirement unresolved for ${next}; launch refused`);
    const path = join(stateDir, "workers", `${parse(SafeId, next)}.json`);
    next = existsSync(path) ? readIdentityRecord(path).parentId : null;
  }
}
export function claimLaunch(stateDir: string, claim: Static<typeof LaunchClaimSchema>) {
  assertNoRetirement(stateDir, claim.workerId);
  const path = join(stateDir, "locks", `launch-${parse(SafeId, claim.workerId)}`);
  mkdirSync(path);
  try {
    assertNoRetirement(stateDir, claim.workerId);
    atomicWrite(join(path, "claim.json"), claim);
  } catch (error) {
    rmSync(path, { recursive: true });
    throw error;
  }
  return {
    path,
    release() {
      const saved = readRecord(LaunchClaimSchema, join(path, "claim.json"));
      if (saved.launchId !== claim.launchId) throw new Error("Launch claim changed; release refused");
      rmSync(path, { recursive: true });
    },
  };
}

export const PlanSchema = Type.Object({
  plan: Type.Array(Type.Object({ step: Type.String(), status: StringEnum(["pending", "in_progress", "completed"] as const) })),
  explanation: Type.Optional(Type.String()),
});
export type Plan = Static<typeof PlanSchema>;
export const PlanRecordSchema = Type.Object({ workerId: Type.String(), piSessionId: Type.String(), ...PlanSchema.properties });
export function planLines(plan: Plan): string[] {
  return plan.plan.map(({ step, status }) => `[${status === "completed" ? "x" : status === "in_progress" ? ">" : " "}] ${step}`);
}
export function selectWorker(ctx: ExtensionContext, choice: { model: Identity["model"]; thinking: Selection["thinking"] }): Selection {
  if (!choice.model) throw new Error("No authoritative model for launch; select a Pi model first");
  const { provider, id } = choice.model;
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) throw new Error(`Unknown model ${provider}/${id}; choose an exact provider/id from Pi's model registry`);
  const supported = getSupportedThinkingLevels(model);
  const level = choice.thinking;
  if (!supported.includes(level)) throw new Error(`Unsupported thinking ${level} for ${provider}/${id}; supported: ${supported.join(", ")}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model) && !ctx.modelRegistry.getProviderAuthStatus(provider).configured)
    throw new Error(`No configured provider authentication for ${provider}/${id}; configure it in Pi before spawning`);
  return { model: { provider, id }, thinking: level };
}
export function recordedThinking(previous: Identity): Selection["thinking"] {
  if (previous.thinking !== null) return previous.thinking;
  // Read-only recovery for pre-selection records. Never open a SessionManager here.
  verifySession(previous);
  const content = readFileSync(previous.piSessionPath, "utf8");
  const entries = parseSessionEntries(content);
  if (entries.length !== content.split("\n").filter(line => line.trim()).length)
    throw new Error("Malformed native history; thinking recovery refused");
  const sessionEntries = entries.filter(entry => entry.type !== "session");
  const byId = new Map<string, (typeof sessionEntries)[number]>();
  for (const entry of sessionEntries) {
    const base = parse(Type.Object({ id: Type.String({ minLength: 1 }), parentId: Type.Union([Type.String(), Type.Null()]) }), entry);
    if (byId.has(base.id) || (base.parentId !== null && !byId.has(base.parentId)))
      throw new Error("Invalid native history path; thinking recovery refused");
    byId.set(base.id, entry);
  }
  let entry = sessionEntries.at(-1);
  let hasThinking = false;
  while (entry) {
    if (entry.type === "thinking_level_change") hasThinking = true;
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
  }
  if (!hasThinking) throw new Error("Worker thinking is unknown: no saved value or native thinking history; reload the original live worker or spawn a fresh worker");
  const restored = buildSessionContext(sessionEntries);
  if (restored.model && (restored.model.provider !== previous.model?.provider || restored.model.modelId !== previous.model?.id))
    throw new Error("Native history model differs from recorded worker model; recovery refused");
  return parse(ThinkingSchema, restored.thinkingLevel);
}
export function roleBrief(role: Identity["role"]): string {
  return `Role: ${role}. An agent started you; your final message is your report to it. No human watches this session. If you need a human decision, stop and report the question.`;
}
// macOS: boot session UUID plus ps start time (one-second resolution). UTC/C keep the birth string identical across callers.
let darwinBootId: string | undefined;
function darwinProcessIdentity(pid: number): { birth: string; state: string } | null {
  const env = { TZ: "UTC", LC_ALL: "C" };
  const ps = spawnSync("/bin/ps", ["-o", "lstart=,stat=", "-p", String(pid)], { encoding: "utf8", env, timeout: 5000 });
  if (ps.error) throw ps.error;
  if (ps.status !== 0) {
    // Only the kernel's ESRCH proves absence; ps output alone could hide a live process.
    try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return null; }
    throw new Error(`Process status unavailable for PID ${pid}: ${ps.stderr.trim()}`);
  }
  const match = /^([A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}) +([A-Z])\S*$/.exec(ps.stdout.trim());
  if (!match?.[1] || !match[2]) throw new Error("Invalid macOS process status");
  darwinBootId ??= execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", env, timeout: 5000 }).trim();
  if (!/^[0-9A-F-]{36}$/.test(darwinBootId)) throw new Error("Invalid macOS boot session UUID");
  return { birth: `${darwinBootId}:${match[1].replace(/ +/g, " ")}`, state: match[2] };
}
export function processIdentity(pid: number): { birth: string; state: string } | null {
  if (process.platform === "darwin") return darwinProcessIdentity(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const start = fields[19];
    const state = fields[0];
    if (!start || !/^\d+$/.test(start) || !state) throw new Error("Invalid Linux process stat");
    return { birth: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`, state };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export function isOriginalProcessLive(identity: Pick<Identity, "pid" | "pidBirth">): boolean {
  const process = processIdentity(identity.pid);
  return process !== null && process.birth === identity.pidBirth && process.state !== "Z" && process.state !== "X";
}
export function verifySession(identity: Pick<Identity, "piSessionId" | "piSessionPath">): void {
  const header = parse(Type.Object({ type: Type.Literal("session"), id: Type.String() }),
    JSON.parse(readFileSync(identity.piSessionPath, "utf8").split("\n")[0] ?? ""));
  if (header.id !== identity.piSessionId) throw new Error("Original Pi session UUID mismatch");
}
export const PaneSchema = Type.Object({ pane_id: Type.String(), workspace_id: Type.String(), tab_id: Type.String(), terminal_id: Type.String() });
export type Pane = Static<typeof PaneSchema>;
export const PaneResponse = Type.Object({ result: Type.Object({ pane: PaneSchema }) });
export const TabResponse = Type.Object({ result: Type.Object({ root_pane: PaneSchema }) });
export function tabPane(response: unknown, workspaceId: string): Pane {
  const pane = parse(TabResponse, response).result.root_pane;
  if (pane.workspace_id !== workspaceId) throw new Error("Created tab belongs to wrong workspace");
  return pane;
}
