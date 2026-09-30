import assert from "node:assert/strict";
import { test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketDirectory } from "./startup.ts";
import { claimLaunch, processIdentity } from "./runtime.ts";
import { atomicWrite } from "./protocol.ts";
import { present, toolText, fixtureEnvironment, replaceEnvironment } from "./fakes.ts";
import { retirementNative, type RetirementMode } from "./test-support/retirement-native.ts";
import { ownChild } from "./test-support/process.ts";
import { finishCleanup } from "./test-support/cleanup.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function retirementFixture(directory: string, originalEnv: NodeJS.ProcessEnv) {
  const suite = retirementNative(directory, { kind: "lead" });
  const { identity, identities, native, controls } = suite;
  const children = new Map<ChildProcess, ReturnType<typeof ownChild>>();
  const fixture = native();
    async function child(childId: string, childMode: RetirementMode = "idle", parentId = "lead", extraEnv: Record<string, string> = {}) {
      rmSync(join(directory, `${childId}.ready`), { force: true });
      const proc = spawn(process.execPath, [fileURLToPath(new URL("./test-support/retirement-child.ts", import.meta.url)), childId, childMode, parentId],
        { env: fixtureEnvironment({ RETIRE_STATE: directory, XDG_RUNTIME_DIR: directory, ...extraEnv }, originalEnv), stdio: ["ignore", "pipe", "pipe"] });
      children.set(proc, ownChild(proc));
      let stderr = "";
      proc.stderr.on("data", chunk => { stderr += chunk; });
      for (let i = 0; !existsSync(join(directory, `${childId}.ready`)) && proc.exitCode === null && i < 200; i++) await delay(50);
      assert.ok(existsSync(join(directory, `${childId}.ready`)), `${childId} failed to start: ${stderr}`);
      identities.set(childId, identity(childId));
      return proc;
    }
    controls.startResumed = async () => {
      const claim = JSON.parse(readFileSync(join(directory, "locks", `launch-${controls.createdId}`, "claim.json"), "utf8"));
      await child(present(controls.createdId, "created id"), "resume", "lead", { DS_HERDR_LAUNCH_ID: claim.launchId,
        DS_HERDR_RESTART_GENERATION: claim.previousGeneration, RETIRE_NEW_PANE: "1" });
    };
    const retire = async (childId: string) => JSON.parse(toolText(await fixture.tools.get("retire_agent").execute("retire", { agent_id: childId }, undefined, undefined, fixture.ctx)));
  return { ...suite, fixture, child, retire,
    exitOf: (child: ChildProcess) => present(children.get(child), "owned retirement child").exited,
    async close() {
      await finishCleanup([], [
        ...[...children.values()].map(child => () => child.stop()),
        () => fixture.emit({ type: "session_shutdown", reason: "quit" }),
      ]);
    },
  };
}
async function withRetirement(check: (suite: Awaited<ReturnType<typeof retirementFixture>> & { directory: string }) => Promise<void>) {
  const directory = mkdtempSync("/tmp/pha-");
  const originalEnv = { ...process.env };
  let suite: Awaited<ReturnType<typeof retirementFixture>> | undefined;
  const errors: unknown[] = [];
  try {
    suite = await retirementFixture(directory, originalEnv);
    const { fixture } = suite;
    await fixture.emit({ type: "session_start", reason: "startup" });
    assert.ok(fixture.tools.has("retire_agent"));
    await check({ ...suite, directory });
  } catch (error) {
    errors.push(error);
  } finally {
    await finishCleanup(errors, [
      () => suite?.close(),
      () => replaceEnvironment(originalEnv),
      () => rmSync(socketDirectory(directory, directory), { recursive: true, force: true }),
      () => rmSync(directory, { recursive: true, force: true }),
    ]);
  }
}

test("idle retirement proves death and closes exact pane", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, closed }) => {
    await child("idle");
    const retired = await retire("idle");
    assert.equal(retired.state, "retired");
    assert.equal(retired.deathVerified, true);
    assert.equal(retired.paneClosed, true);
    assert.ok(closed.has("idle"));
}));

test("retirement is repeatable and rejects finished record missing proof", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, directory, identity }) => {
    await child("idle");
    const old = identity("idle");
    await retire("idle");
    assert.equal((await retire("idle")).state, "retired");
    const finishedPath = join(directory, "operations", `retire-idle-${old.generation}.json`);
    const finished = JSON.parse(readFileSync(finishedPath, "utf8"));
    atomicWrite(finishedPath, { ...finished, result: { ...finished.result, deathVerified: false } });
    await assert.rejects(retire("idle"), /Invalid protocol or persisted record/,
      "a finished result without all three proofs cannot be accepted");
    atomicWrite(finishedPath, finished);
}));

test("finished-fence recovery refuses wrong generation and live lease then recovers dead lease", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, directory, identity }) => {
    await child("idle");
    const old = identity("idle");
    await retire("idle");
    const strandedFence = join(directory, "locks", "retire-idle");
    mkdirSync(strandedFence); // Caller lost after atomic finished record, before fence removal.
    const fenceClaim = join(strandedFence, "claim.json");
    atomicWrite(fenceClaim, { workerId: "idle", generation: "other-generation",
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath });
    await assert.rejects(retire("idle"), /different conversation or generation/);
    assert.ok(existsSync(strandedFence), "mismatched fence is never removed");
    atomicWrite(fenceClaim, { workerId: "idle", generation: old.generation,
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath });
    const inFlight = join(strandedFence, "inflight");
    mkdirSync(inFlight);
    const birth = processIdentity(process.pid);
    assert.ok(birth);
    atomicWrite(join(inFlight, "owner.json"), { workerId: "idle", generation: old.generation,
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath,
      pid: process.pid, pidBirth: birth.birth, token: "conflicting-owner" });
    await assert.rejects(retire("idle"), /already active/, "do not remove a live operation's fence");
    assert.ok(existsSync(strandedFence));
    atomicWrite(join(inFlight, "owner.json"), { workerId: "idle", generation: old.generation,
      piSessionId: old.piSessionId, piSessionPath: old.piSessionPath,
      pid: process.pid, pidBirth: "dead-original-birth", token: "abandoned-owner" });
    assert.equal((await retire("idle")).state, "retired", "a dead lease allows exclusive finished-fence recovery");
    assert.equal(existsSync(strandedFence), false, "finished receipt retry must remove its stranded fence");
}));

test("cold followup after retirement preserves conversation and selection in new generation", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, identity, fixture }) => {
    await child("idle");
    const old = identity("idle");
    await retire("idle");
    const idleFollowup = JSON.parse(toolText(await fixture.tools.get("followup_task").execute("idle-cold", {
      agent_id: "idle", task: "only new work after finished fence cleanup",
    }, undefined, undefined, fixture.ctx)));
    assert.equal(idleFollowup.kind, "accepted");
    assert.equal(idleFollowup.identity.piSessionId, old.piSessionId);
    assert.notEqual(idleFollowup.identity.generation, old.generation);
    assert.equal(idleFollowup.identity.model.id, old.model.id);
    assert.equal(idleFollowup.identity.thinking, old.thinking);
    assert.equal(identity("idle").piSessionId, old.piSessionId);
    assert.equal(identity("idle").model.id, "model");
}));

test("busy worker retirement is refused without closure", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, closed }) => {
    await child("busy", "busy");
    await assert.rejects(retire("busy"), /Retirement refused/);
    assert.ok(!closed.has("busy"));
}));

test("retirement and submit admit exactly one winner", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, identity, query }) => {
    await child("race");
    const raceTarget = identity("race");
    const race = await Promise.allSettled([
      retire("race"),
      query(raceTarget, { kind: "submit", submissionId: "racing-task", task: "one task" }),
    ]);
    const retirementWon = race[0].status === "fulfilled" && race[0].value.state === "retired";
    const submissionWon = race[1].status === "fulfilled" && race[1].value.kind !== "unavailable";
    assert.notEqual(retirementWon, submissionWon, "retirement and submit must not both succeed or both vanish");
}));

test("followup racing retirement cannot use retiring generation", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, fixture }) => {
    await child("followup-race");
    const followup = await Promise.allSettled([
      retire("followup-race"),
      fixture.tools.get("followup_task").execute("new", { agent_id: "followup-race", task: "only new work" }, undefined, undefined, fixture.ctx),
    ]);
    if (followup[0].status === "fulfilled" && followup[1].status === "fulfilled" && followup[0].value.state === "retired") {
      const next = JSON.parse(toolText(followup[1].value));
      assert.notEqual(next.generation, followup[0].value.generation,
        "a follow-up after retirement must use a new generation, never the retiring writer");
    }
}));

test("queued worker retirement is refused", { timeout: 30_000 }, () => withRetirement(async ({ child, retire }) => {
    await child("queued", "queued");
    await assert.rejects(retire("queued"), /Retirement refused/);
}));

test("pending worker retirement is refused", { timeout: 30_000 }, () => withRetirement(async ({ child, retire }) => {
    await child("pending", "pending");
    await assert.rejects(retire("pending"), /Retirement refused/);
}));

test("live descendant and unresolved descendant launch block ancestor retirement", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, identity, directory, closed }) => {
    await child("busy", "busy");
    await child("ancestor");
    await child("leaf", "idle", "ancestor");
    await assert.rejects(retire("ancestor"), /Descendant leaf live/);
    assert.equal((await retire("leaf")).state, "retired");
    const ancestorIdentity = identity("ancestor");
    const childClaim = claimLaunch(directory, { launchId: "ghost-launch", workerId: "ghost", previousGeneration: null,
      piSessionPath: join(directory, "sessions", "ghost.jsonl"), model: { provider: "fixture", id: "model" },
      thinking: "medium", callerId: "ancestor", callerGeneration: ancestorIdentity.generation,
      pid: ancestorIdentity.pid, pidBirth: ancestorIdentity.pidBirth });
    await assert.rejects(retire("ancestor"), /In-flight descendant launch/);
    childClaim.release();
    assert.equal((await retire("ancestor")).state, "retired");
    assert.ok(!closed.has("busy"));
}));

test("failed shutdown fences cold continuation until cleanup retry", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, fixture, directory, identity, closed, exitOf }) => {
    const stuck = await child("stuck", "no-shutdown");
    const abort = new AbortController();
    const operation = fixture.tools.get("retire_agent").execute("retire", { agent_id: "stuck" }, abort.signal, undefined, fixture.ctx);
    setTimeout(() => abort.abort(), 150);
    const incomplete = JSON.parse(toolText(await operation));
    assert.equal(incomplete.state, "incomplete");
    assert.equal(incomplete.shutdownRequested, true);
    assert.equal(incomplete.deathVerified, false);
    assert.ok(existsSync(join(directory, "locks", "retire-stuck")));
    assert.ok(!closed.has("stuck"));
    assert.throws(() => claimLaunch(directory, { launchId: "blocked", workerId: "stuck", previousGeneration: identity("stuck").generation,
      piSessionPath: join(directory, "sessions", "stuck.jsonl"), model: { provider: "fixture", id: "model" },
      thinking: "medium", callerId: "lead", callerGeneration: identity("lead").generation,
      pid: identity("lead").pid, pidBirth: identity("lead").pidBirth }), /Retirement unresolved/);
    assert.ok(stuck.exitCode === null);
    const stopped = exitOf(stuck);
    stuck.kill("SIGTERM");
    await stopped;
    assert.equal((await retire("stuck")).state, "retired", "cleanup retry must not resend a task");
}));

test("retirement needs no selected model or auth", { timeout: 30_000 }, () => withRetirement(async ({ child, retire }) => {
    await child("noauth", "noauth");
    assert.equal((await retire("noauth")).state, "retired", "retirement needs no current model or auth");
}));

test("historical retirement and cold continuation preserve task records and results", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, directory, identity, fixture, query }) => {
    await child("historical");
    const oldTask = { kind: "settled", workerId: "historical", generation: identity("historical").generation,
      piSessionId: "pi-historical", submissionId: "old-result", task: "original task", startedAt: "before",
      outcome: "completed", settledAt: "after", finalText: "exact historical result", artifactPath: join(directory, "artifact.md") };
    const taskFile = join(directory, "tasks", "historical", "old-result.json");
    atomicWrite(taskFile, oldTask);
    assert.equal((await retire("historical")).state, "retired");
    assert.deepEqual(JSON.parse(readFileSync(taskFile, "utf8")), oldTask, "retirement must not rewrite settled records");
    const revived = JSON.parse(toolText(await fixture.tools.get("followup_task").execute("cold", { agent_id: "historical", task: "only the new task" }, undefined, undefined, fixture.ctx)));
    assert.equal(revived.kind, "accepted");
    assert.equal(revived.identity.piSessionId, "pi-historical");
    assert.equal(revived.identity.workerId, "historical");
    assert.notEqual(revived.identity.generation, oldTask.generation);
    assert.equal(revived.identity.thinking, "medium");
    assert.equal(revived.identity.model.id, "model");
    assert.deepEqual(JSON.parse(readFileSync(taskFile, "utf8")), oldTask);
    const historicalResult = await query(identity("historical"), { kind: "wait", submissionId: "old-result", timeoutMs: 10 });
    if (!("finalText" in historicalResult)) throw new Error("expected historical result");
    assert.equal(historicalResult.finalText, "exact historical result");
}));

test("replacement occupant leaves pane untouched until retry", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, faults, closed }) => {
    await child("replaced");
    faults.set("replaced", "occupant");
    const replacement = await retire("replaced");
    assert.equal(replacement.state, "incomplete");
    assert.equal(replacement.deathVerified, true);
    assert.ok(!closed.has("replaced"));
    faults.delete("replaced");
    assert.equal((await retire("replaced")).state, "retired");
}));

test("changed tab leaves pane untouched until retry", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, faults, closed }) => {
    await child("moved");
    faults.set("moved", "moved");
    assert.equal((await retire("moved")).state, "incomplete");
    assert.ok(!closed.has("moved"));
    faults.delete("moved");
    assert.equal((await retire("moved")).state, "retired");
}));

test("changed terminal leaves pane untouched until retry", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, faults, closed }) => {
    await child("terminal");
    faults.set("terminal", "terminal");
    assert.equal((await retire("terminal")).state, "incomplete");
    assert.ok(!closed.has("terminal"));
    faults.delete("terminal");
    assert.equal((await retire("terminal")).state, "retired");
}));

test("server-wide pane absence completes without guessed closure", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, faults, closed }) => {
    await child("absent");
    faults.set("absent", "absent");
    assert.equal((await retire("absent")).state, "retired", "Server-wide pane absence after death is sufficient");
    assert.ok(!closed.has("absent"), "already absent pane is never closed by guessed ID");
}));

    for (const fault of ["workspace-move", "pane-id-move"]) {
test(`moved ${fault} is not absence`, { timeout: 30_000 }, () => withRetirement(async ({ child, retire, faults, closed }) => {
      await child(fault);
      faults.set(fault, fault);
      const result = await retire(fault);
      assert.equal(result.state, "incomplete", `${fault} must not count as absence`);
      assert.equal(result.deathVerified, true);
      assert.equal(result.paneClosed, false);
      assert.ok(!closed.has(fault));
      faults.delete(fault);
      assert.equal((await retire(fault)).state, "retired");
}));

}

    for (const fault of ["empty-foreground", "missing-foreground", "missing-group", "null-group", "null-shell", "foreign-group", "foreign-process"]) {
test(`unproven foreground ${fault} refuses closure`, { timeout: 30_000 }, () => withRetirement(async ({ child, retire, faults, closed }) => {
      await child(fault);
      faults.set(fault, fault);
      const result = await retire(fault);
      assert.equal(result.state, "incomplete", `${fault} does not affirm a foreground shell`);
      assert.ok(!closed.has(fault), `${fault} must leave the pane alone`);
      faults.delete(fault);
      assert.equal((await retire(fault)).state, "retired");
}));

}

test("cancellation after death before close leaves pane untouched", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, controls, fixture, closed }) => {
    await child("cleanup-abort");
    controls.cleanupAbort = new AbortController();
    controls.abortPoint = "process-info";
    const abortedBeforeClose = JSON.parse(toolText(await fixture.tools.get("retire_agent").execute("abort-cleanup", {
      agent_id: "cleanup-abort" }, present(controls.cleanupAbort, "cleanup abort controller").signal, undefined, fixture.ctx)));
    assert.equal(abortedBeforeClose.state, "incomplete");
    assert.equal(abortedBeforeClose.deathVerified, true);
    assert.equal(abortedBeforeClose.paneClosed, false);
    assert.ok(!closed.has("cleanup-abort"));
    controls.abortPoint = undefined;
    assert.equal((await retire("cleanup-abort")).state, "retired");
}));

test("cancellation during close retains observed absence for retry", { timeout: 30_000 }, () => withRetirement(async ({ child, retire, controls, fixture, closed }) => {
    await child("abort-after-close");
    controls.cleanupAbort = new AbortController();
    controls.abortPoint = "close";
    const abortedAfterClose = JSON.parse(toolText(await fixture.tools.get("retire_agent").execute("abort-after-close", {
      agent_id: "abort-after-close" }, present(controls.cleanupAbort, "cleanup abort controller").signal, undefined, fixture.ctx)));
    assert.equal(abortedAfterClose.state, "incomplete");
    assert.equal(abortedAfterClose.deathVerified, true);
    assert.equal(abortedAfterClose.paneClosed, true, "observed closure survives cancellation");
    assert.ok(closed.has("abort-after-close"));
    controls.abortPoint = undefined;
    assert.equal((await retire("abort-after-close")).state, "retired", "retry verifies absence without another close");
}));

test("lost close response is incomplete even after observed absence", { timeout: 30_000 }, () => withRetirement(async ({ child, retire }) => {
    await child("close-error");
    const uncertainClose = await retire("close-error");
    assert.equal(uncertainClose.state, "incomplete", "close command failure is not a successful retirement");
    assert.equal(uncertainClose.paneClosed, true, "observed absence survives a lost close response");
    assert.equal((await retire("close-error")).state, "retired");
}));

test("caller shutdown waits for outbound retirement evidence and retains unresolved fence", { timeout: 30_000 }, () => withRetirement(async ({ child, directory, identity, fixture }) => {
    await child("reload-pending", "no-shutdown");
    const reloadAbort = new AbortController();
    const outbound = fixture.tools.get("retire_agent").execute("reload", { agent_id: "reload-pending" },
      reloadAbort.signal, undefined, fixture.ctx);
    const evidence = join(directory, "operations", `retire-reload-pending-${identity("reload-pending").generation}.json`);
    for (let i = 0; !existsSync(evidence) && i < 100; i++) await delay(10);
    assert.ok(existsSync(evidence), "retirement must reserve before caller shutdown");
    let cleaned = false;
    const shuttingDown = fixture.emit({ type: "session_shutdown", reason: "quit" }).then(() => { cleaned = true; });
    await delay(30);
    assert.equal(cleaned, false, "caller cleanup waits for its outbound retirement to record an outcome");
    reloadAbort.abort();
    const aborted = JSON.parse(toolText(await outbound));
    assert.equal(aborted.state, "incomplete");
    await shuttingDown;
    assert.equal(cleaned, true);
    assert.equal(JSON.parse(readFileSync(evidence, "utf8")).kind, "incomplete");
    assert.ok(existsSync(join(directory, "locks", "retire-reload-pending")), "reload leaves unresolved worker fenced");
}));
