import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { atomicWrite, ModelSchema, parse, readRecord, SafeId, type Identity } from "./protocol.ts";

export const LaunchClaimSchema = Type.Object({
  launchId: SafeId, workerId: SafeId, previousGeneration: Type.Union([SafeId, Type.Null()]),
  piSessionPath: Type.String(), model: ModelSchema, callerId: SafeId, callerGeneration: SafeId,
  pid: Type.Integer({ minimum: 1 }), pidBirth: Type.String({ minLength: 1 }),
});
export function claimLaunch(stateDir: string, claim: Static<typeof LaunchClaimSchema>) {
  const path = join(stateDir, "locks", `launch-${parse(SafeId, claim.workerId)}`);
  mkdirSync(path);
  atomicWrite(join(path, "claim.json"), claim);
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
export function thinking(role: Identity["role"]): "low" | "medium" | "high" {
  return role === "judgment" ? "high" : role === "implement" || role === "review" ? "medium" : "low";
}
export function roleBrief(role: Identity["role"]): string {
  return `Role: ${role}. Own the complete task in your brief and any descendants you spawn. Fresh children receive only their brief, not parent conversation history. Respect the brief's writable paths and edit permission. Use Git, tests, and scratch probes as needed. ${role === "review" || role === "explore" ? "Report findings rather than apply implementation fixes." : "Produce the deliverable requested by the brief."} Keep reports under 800 words with changed paths, checks, evidence paths, and open risks. Record workerId and submissionId; wait on the exact submission. update_plan changes only your own session plan, never the lead's. For a genuine human preference question, stop and report the question for the real user; never invent their answer.`;
}
export function processIdentity(pid: number): { birth: string; state: string } | null {
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
