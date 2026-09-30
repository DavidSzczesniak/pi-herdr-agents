import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { present } from "./fakes.ts";
import { dependencyLinkScript } from "./link-guard.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClaudeHost } from "./claude.ts";
import { claudeCommand, interruptClaude, listClaude, pendingWork, readClaudeWorker, readTranscript, retireClaude, spawnClaude, unresolvedClaudeChild, waitClaude } from "./claude.ts";
import { test } from "vitest";
import { randomUUID } from "node:crypto";
import { ownChild } from "./test-support/process.ts";
import { finishCleanup } from "./test-support/cleanup.ts";
import { ownTestCleanup } from "./test-support/ownership.ts";

const completeWait = (result: Awaited<ReturnType<typeof waitClaude>>) => { if (result.kind === "timeout") throw new Error(`Claude wait timed out: ${JSON.stringify(result)}`); return result; };
const timedOut = (result: Awaited<ReturnType<typeof waitClaude>>) => { if (result.kind !== "timeout") throw new Error(`expected Claude timeout, got ${result.kind}`); return result; };

function claudeFixture(root: string) {
  const stateDir = join(root, "state");
  for (const dir of ["", "artifacts", "claude"]) mkdirSync(join(stateDir, dir), { recursive: true, mode: 0o700 });
  const cwd = join(root, "repo");
  mkdirSync(cwd);

  const fakeClaude = join(root, "bin", "claude");
  mkdirSync(join(root, "bin"));
  writeFileSync(fakeClaude, `#!${process.execPath}\n${readFileSync(new URL("./test-support/fake-claude.cjs", import.meta.url), "utf8")}`);
  chmodSync(fakeClaude, 0o755);
  type Pane = { pane_id: string; workspace_id: string; tab_id: string; terminal_id: string; cwd: string; output: string; child?: ChildProcessWithoutNullStreams };
  const panes = new Map<string, Pane>();
  const processes = new Map<ChildProcessWithoutNullStreams, ReturnType<typeof ownChild>>();
  let counter = 0;
  const herdrCalls: string[][] = [];
  let onCreate: (() => Promise<unknown>) | undefined;
  let onClose: ((paneId: string, pane: Pane | undefined) => Promise<void> | void) | undefined;
  let onRun: (() => void) | undefined;
  async function herdr(args: string[]): Promise<unknown> {
    herdrCalls.push(args);
    const [group, verb] = args;
    if (group === "tab" && verb === "create") {
      if (onCreate) return onCreate();
      counter += 1;
      const pane = { pane_id: `w1:p${counter}`, workspace_id: "w1", tab_id: `w1:t${counter}`, terminal_id: `term-${counter}` };
      panes.set(pane.pane_id, { ...pane, cwd: present(args[args.indexOf("--cwd") + 1], "pane cwd"), output: "" });
      return { result: { tab: { tab_id: pane.tab_id }, root_pane: pane } };
    }
    if (group === "pane" && verb === "run") {
      const pane = panes.get(present(args[2], "pane id"));
      if (!pane) throw new Error("pane is missing");
      pane.child = spawn("sh", ["-c", present(args[3], "pane command")], { detached: true, cwd: pane.cwd, env: { ...process.env, ANTHROPIC_API_KEY: "leaked", CLAUDE_CODE_USE_BEDROCK: "1" } });
      processes.set(pane.child, ownChild(pane.child, true));
      present(pane.child, "pane process").stdout.on("data", (chunk: Buffer) => { pane.output += chunk; });
      present(pane.child, "pane process").stderr.on("data", (chunk: Buffer) => { pane.output += chunk; });
      onRun?.();
      return undefined;
    }
    if (group === "pane" && verb === "list") {
      return { result: { panes: [...panes.values()].map(({ output, child, cwd: _, ...shape }) => shape) } };
    }
    if (group === "pane" && verb === "get") {
      const pane = panes.get(present(args[2], "pane id"));
      if (!pane) throw new Error('{"error":{"code":"pane_not_found"}}');
      const { output, child, cwd: _, ...shape } = pane;
      return { result: { pane: shape } };
    }
    if (group === "pane" && verb === "close") {
      const pane = panes.get(present(args[2], "pane id"));
      if (pane?.child) await present(processes.get(pane.child), "owned pane process").stop();
      panes.delete(present(args[2], "pane id"));
      await onClose?.(present(args[2], "pane id"), pane);
      return undefined;
    }
    throw new Error(`unexpected herdr ${args.join(" ")}`);
  }
  const audits: { event: string; data: unknown }[] = [];
  let detached = false;
  const host: ClaudeHost = { stateDir, workerId: "lead", workspaceId: "w1", claudeCommand: fakeClaude, herdr,
    admit() { if (detached) throw new Error("Worker unavailable"); },
    readPane: async (id) => panes.get(id)?.output ?? "", audit: (event, data) => audits.push({ event, data }) };
  const spec = (task: string, extra: Partial<Parameters<typeof spawnClaude>[1]> = {}): Parameters<typeof spawnClaude>[1] => ({ role: "review", cwd, task, model: "claude-opus-5-5", effort: "high", ...extra });
  const paneOf = (id: string) => readClaudeWorker(stateDir, id).paneId;
  mkdirSync(join(stateDir, "operations"));
  mkdirSync(join(root, "transcripts"));
  const tpath = (name: string) => join(root, "transcripts", `${name}.jsonl`);
  return { root, stateDir, cwd, fakeClaude, panes, herdrCalls, herdr, audits, host, spec, paneOf, tpath,
    controls: {
      set onCreate(value: typeof onCreate) { onCreate = value; },
      set onClose(value: typeof onClose) { onClose = value; },
      set onRun(value: typeof onRun) { onRun = value; },
      set detached(value: boolean) { detached = value; },
    },
    async close() {
      await finishCleanup([], [...processes.values()].map(process => () => process.stop()));
    },
  };
}
async function withClaude(check: (suite: ReturnType<typeof claudeFixture>) => Promise<void>) {
  const root = mkdtempSync("/tmp/pha-");
  let suite: ReturnType<typeof claudeFixture> | undefined;
  const errors: unknown[] = [];
  const remove = () => rmSync(root, { recursive: true, force: true });
  const ownedCleanup = ownTestCleanup(() => [() => suite?.close(), remove], [remove]);
  try {
    suite = claudeFixture(root);
    await check(suite);
  } catch (error) {
    errors.push(error);
  } finally {
    await ownedCleanup.finish(errors);
  }
}

function transcriptEntries() {
  const clock = Date.now();
  const at = (offset: number) => new Date(clock + offset).toISOString();
  const call = (id: string, name: string, input: Record<string, unknown>, offset = 0) => ({ timestamp: at(offset), type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const reply = (id: string, toolUseResult: Record<string, unknown>, isError = false, offset = 0) => ({ timestamp: at(offset), type: "user", toolUseResult,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: isError }] } });
  const notified = (id: string, offset: number) => ({ timestamp: at(offset), type: "user", message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>` } });
  const job = [call("j1", "Bash", { command: "npm test", run_in_background: true }), reply("j1", { backgroundTaskId: "b1" })];
  const enqueued = { type: "queue-operation", operation: "enqueue", content: "<task-notification><tool-use-id>j1</tool-use-id><status>completed</status></task-notification>" };
  const midTurn = (prompt: string | { type: string; text: string }[], commandMode = "task-notification") => ({ type: "attachment", attachment: { type: "queued_command", prompt, commandMode } });
  const finished = "<task-notification><tool-use-id>j1</tool-use-id><status>completed</status></task-notification>";
  return { clock, at, call, reply, notified, job, enqueued, midTurn, finished };
}

test("hook acceptance records baseline and Stop completion stores full artifact", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  assert.equal(done.kind, "accepted");
  assert.equal(done.evidence, "user_prompt_submit");
  assert.ok(existsSync(join(host.stateDir, "operations", `submitted-${done.workerId}-${done.submissionId}.json`)), "acceptance records the transcript baseline");
  const settled = completeWait(await waitClaude(host, done.workerId, done.submissionId, 10000));
  assert.equal(settled.kind, "settled");
  assert.equal(settled.outcome, "completed");
  assert.match(settled.finalText, /^done model=claude-opus-5-5 effort=high apiKey=unset bedrock=unset /, "credentials and provider routing are unset");
  assert.equal(readFileSync(present(settled.artifactPath, "settled artifact"), "utf8"), settled.finalText);
  assert.equal(settled.transcriptPath, join(stateDir, "claude", done.workerId, "transcript.jsonl"));
}));

test("launch isolates credentials and leaf options and installs Bash hooks", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, cwd, herdrCalls }) => {
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  const settled = completeWait(await waitClaude(host, done.workerId, done.submissionId, 10000));
  assert.match(settled.finalText, /^done model=claude-opus-5-5 effort=high apiKey=unset bedrock=unset /, "credentials and provider routing are unset");
  const { hooks } = JSON.parse(readFileSync(join(stateDir, "claude", done.workerId, "settings.json"), "utf8"));
  const linkCheck = [{ matcher: "Bash", hooks: [{ type: "command", command: `'/bin/sh' '${dependencyLinkScript}' '${cwd}'`, timeout: 5 }] }];
  assert.deepEqual([hooks.PostToolUse, hooks.PostToolUseFailure], [linkCheck, linkCheck], "Bash results, failed or not, run the dependency-link check in the worker's cwd");
  assert.ok(Buffer.byteLength(present(present(herdrCalls.find((args) => args[1] === "run"), "run command")[3], "exec line")) < 1024, "Herdr types only a short exec line");
}));

test("unknown submission is refused", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  await assert.rejects(waitClaude(host, done.workerId, "other-submission", 1000), /Unknown submission/);
}));

test("option-looking brief remains task text", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const dashed = await spawnClaude(host, spec("--settings=/tmp/evil.json --help SCENARIO:complete"));
  assert.equal((completeWait(await waitClaude(host, dashed.workerId, dashed.submissionId, 10000))).outcome, "completed");
}));

test("oversized brief reaches fake Claude through file pointer", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const large = await spawnClaude(host, spec("x".repeat(130000) + " SCENARIO:complete"));
  const largeResult = completeWait(await waitClaude(host, large.workerId, large.submissionId, 10000));
  assert.match(largeResult.finalText, /bytes=130018$/, "the worker read the whole brief from the file");
}));

test("first own-session Stop wins and each hook keeps its own file", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const twice = await spawnClaude(host, spec("SCENARIO:twice"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((completeWait(await waitClaude(host, twice.workerId, twice.submissionId, 10000))).finalText, "first turn");
  assert.equal(readdirSync(join(stateDir, "claude", twice.workerId, "hooks")).filter((name) => name.startsWith("Stop-")).length, 2,
    "each hook invocation keeps its own file");
}));

test("other-session Stop cannot settle accepted work", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const other = await spawnClaude(host, spec("SCENARIO:othersession"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((completeWait(await waitClaude(host, other.workerId, other.submissionId, 10000))).finalText, "own session");
}));

test("StopFailure is an error and can be retired", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const failed = await spawnClaude(host, spec("SCENARIO:fail"));
  const failure = completeWait(await waitClaude(host, failed.workerId, failed.submissionId, 10000));
  assert.equal(failure.outcome, "error");
  assert.equal(failure.reason, "rate_limit");
  assert.equal((await retireClaude(host, failed.workerId)).state, "retired");
  assert.equal(readClaudeWorker(stateDir, failed.workerId).task.outcome, "error");
}));

test("SessionEnd without result is unavailable and can be retired", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const ended = await spawnClaude(host, spec("SCENARIO:end"));
  const end = completeWait(await waitClaude(host, ended.workerId, ended.submissionId, 10000));
  assert.equal(end.kind, "unavailable");
  assert.match(present(end.reason, "session end reason"), /ended without a result \(logout\)/);
  assert.equal((await retireClaude(host, ended.workerId)).state, "retired");
}));

test("trust dialog fails fast without answering and closes exact new pane", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const trustStarted = Date.now();
  await assert.rejects(spawnClaude(host, spec("SCENARIO:trust"), undefined, 60000), /does not trust .*trust it, then retry.*Cleanup exact new pane closed/s);
  assert.ok(Date.now() - trustStarted < 15000, "a trust dialog fails fast instead of waiting out the startup deadline");
}));

test("cancel after creation cleans exact pane", { timeout: 30000 }, () => withClaude(async ({ host, spec, controls, herdr, cwd }) => {
  const abort = new AbortController();
  controls.onCreate = () => { controls.onCreate = undefined; const result = herdr(["tab", "create", "--cwd", cwd]); abort.abort(); return result; };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete"), abort.signal), /Cleanup exact new pane closed/);
}));

test("lost creation response retains uncertain cleanup", { timeout: 30000 }, () => withClaude(async ({ host, spec, controls }) => {
  controls.onCreate = () => { controls.onCreate = undefined; throw new Error("fixture: creation response lost"); };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Cleanup uncertain: tab creation outcome unknown/);
}));

test("overlong launch line is rejected before Herdr calls", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, herdrCalls }) => {
  const deepHost = { ...host, stateDir: join(stateDir, "d".repeat(250), "e".repeat(250), "f".repeat(250), "g".repeat(250)) };
  const before = herdrCalls.length;
  await assert.rejects(spawnClaude(deepHost, spec("SCENARIO:complete")), /launch line too long/);
  assert.equal(herdrCalls.length, before);
}));

test("overlapping hooks produce complete separate files", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const overlap = await spawnClaude(host, spec("SCENARIO:overlap"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const overlapResult = completeWait(await waitClaude(host, overlap.workerId, overlap.submissionId, 10000));
  assert.ok(["overlap a", "overlap b"].includes(overlapResult.finalText));
  const overlapHooks = readdirSync(join(stateDir, "claude", overlap.workerId, "hooks"));
  assert.equal(overlapHooks.filter((name) => name.startsWith("Stop-")).length, 2);
  assert.ok(!overlapHooks.some((name) => name.endsWith(".tmp")));
}));

test("concurrent observers agree and settle exactly once", { timeout: 30000 }, () => withClaude(async ({ host, spec, audits }) => {
  const shared = await spawnClaude(host, spec("SCENARIO:complete"));
  const [first, second] = await Promise.all([waitClaude(host, shared.workerId, shared.submissionId, 10000), waitClaude(host, shared.workerId, shared.submissionId, 10000)]);
  assert.deepEqual(first, second);
  assert.equal(audits.filter((entry) => entry.event === "claude_settlement" && (typeof entry.data === "object" && entry.data !== null && "claudeWorkerId" in entry.data ? entry.data.claudeWorkerId : undefined) === shared.workerId).length, 1);
}));

test("oversized error is capped at 4000 characters", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const huge = await spawnClaude(host, spec("SCENARIO:hugefail"));
  const hugeResult = completeWait(await waitClaude(host, huge.workerId, huge.submissionId, 10000));
  assert.equal(hugeResult.outcome, "error");
  assert.equal(present(hugeResult.reason, "oversized error").length, 4000);
}));

test("detached host refuses waits", { timeout: 30000 }, () => withClaude(async ({ host, spec, controls }) => {
  const late = await spawnClaude(host, spec("SCENARIO:hang"));
  controls.detached = true;
  await assert.rejects(waitClaude(host, late.workerId, late.submissionId, 2000), /Worker unavailable/);
  controls.detached = false;
}));

test("uncertain server-side creation blocks parent retirement", { timeout: 30000 }, () => withClaude(async ({ host, spec, controls, herdr, cwd, stateDir }) => {
  controls.onCreate = async () => { controls.onCreate = undefined; await herdr(["tab", "create", "--cwd", cwd]); throw new Error("fixture: response lost after creation"); };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Cleanup uncertain: tab creation outcome unknown/);
  const uncertainId = readdirSync(join(stateDir, "claude")).find((id) => {
    try { return JSON.parse(readFileSync(join(stateDir, "claude", id, "launch.json"), "utf8")).cleanup?.startsWith("uncertain: tab creation"); } catch { return false; }
  });
  assert.ok(uncertainId);
  assert.equal(unresolvedClaudeChild(stateDir, parentId => parentId === "lead"), uncertainId);
}));

test("active timeout remains active and cannot be retired", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const hung = await spawnClaude(host, spec("SCENARIO:hang"));
  assert.deepEqual(await waitClaude(host, hung.workerId, hung.submissionId, 1500),
    { kind: "timeout", runtime: "claude", workerId: hung.workerId, submissionId: hung.submissionId, active: true, pending: [] });
  await assert.rejects(retireClaude(host, hung.workerId), /active task/);
  assert.ok(unresolvedClaudeChild(stateDir, (parentId) => parentId === "lead"), "open or active Claude children block parent retirement");
  assert.equal(unresolvedClaudeChild(stateDir, (parentId) => parentId === "someone-else"), undefined);
}));

test("interrupt in split tab closes only the owned pane and permits retirement", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, cwd, panes }) => {
  const hung = await spawnClaude(host, spec("SCENARIO:hang"));
  const hungPane = readClaudeWorker(stateDir, hung.workerId);
  panes.set("w1:split", { pane_id: "w1:split", workspace_id: "w1", tab_id: hungPane.tabId, terminal_id: "term-split", cwd, output: "" });
  const interrupted = await interruptClaude(host, hung.workerId, hung.submissionId);
  assert.equal(interrupted.outcome, "interrupted");
  assert.ok(!panes.has(hungPane.paneId) && panes.has("w1:split"), "only the exact Claude pane closed");
  assert.equal(readClaudeWorker(stateDir, hung.workerId).state, "closed");
  assert.equal((await retireClaude(host, hung.workerId)).state, "retired");
  assert.equal(readClaudeWorker(stateDir, hung.workerId).task.outcome, "interrupted");
}));

test("result arriving during interrupt close wins and clears intent", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, controls, paneOf }) => {
  const racing = await spawnClaude(host, spec("SCENARIO:hang"));
  controls.onClose = (paneId) => {
    if (paneId !== paneOf(racing.workerId)) return;
    writeFileSync(join(stateDir, "claude", racing.workerId, "hooks", "Stop-1-1.json"), JSON.stringify({ session_id: "s1", last_assistant_message: "finished first" }));
    appendFileSync(join(stateDir, "claude", racing.workerId, "transcript.jsonl"), JSON.stringify({ type: "system", subtype: "stop_hook_summary",
      hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] }) + "\n");
  };
  const raced = await interruptClaude(host, racing.workerId, racing.submissionId);
  controls.onClose = undefined;
  assert.equal(raced.outcome, "completed");
  assert.equal(raced.finalText, "finished first");
  assert.equal(readClaudeWorker(stateDir, racing.workerId).interrupting, false, "a result settled during the close clears the interrupt flag");
}));

test("observer during interrupt close records interrupted", { timeout: 30000 }, () => withClaude(async ({ host, spec, controls, paneOf }) => {
  const contested = await spawnClaude(host, spec("SCENARIO:hang"));
  let observed: Awaited<ReturnType<typeof completeWait>> | undefined;
  controls.onClose = async (paneId) => {
    if (paneId === paneOf(contested.workerId)) observed = completeWait(await waitClaude(host, contested.workerId, contested.submissionId, 3000));
  };
  const contestedResult = await interruptClaude(host, contested.workerId, contested.submissionId);
  controls.onClose = undefined;
  assert.equal(present(observed, "interrupt observation").outcome, "interrupted", "an observer that sees the pane gone mid-interrupt records the interruption");
  assert.equal(contestedResult.outcome, "interrupted");
}));

test("abandoned interrupt intent settles once pane is absent", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, panes, paneOf }) => {
  const orphaned = await spawnClaude(host, spec("SCENARIO:hang"));
  const orphanedPath = join(stateDir, "claude", orphaned.workerId, "worker.json");
  writeFileSync(orphanedPath, JSON.stringify({ ...JSON.parse(readFileSync(orphanedPath, "utf8")), interrupting: true }));
  present(present(panes.get(paneOf(orphaned.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(orphaned.workerId));
  assert.equal((completeWait(await waitClaude(host, orphaned.workerId, orphaned.submissionId, 3000))).outcome, "interrupted");
}));

test("detachment during acceptance leaves failed cleanup receipt", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, controls }) => {
  controls.onRun = () => { controls.onRun = undefined; controls.detached = true; };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Worker unavailable/);
  controls.detached = false;
  const detachedLaunch = readdirSync(join(stateDir, "claude")).map((id) => JSON.parse(readFileSync(join(stateDir, "claude", id, "launch.json"), "utf8")))
    .find((receipt) => receipt.error?.includes("Worker unavailable"));
  assert.equal(detachedLaunch.kind, "failed");
  assert.match(detachedLaunch.cleanup, /^exact new pane closed; worker record not updated/);
}));

test("pane loss without result becomes unavailable", { timeout: 30000 }, () => withClaude(async ({ host, spec, panes, paneOf }) => {
  const lost = await spawnClaude(host, spec("SCENARIO:hang"));
  present(present(panes.get(paneOf(lost.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(lost.workerId));
  const lostResult = completeWait(await waitClaude(host, lost.workerId, lost.submissionId, 5000));
  assert.equal(lostResult.kind, "unavailable");
  assert.match(present(lostResult.reason, "lost pane reason"), /closed without a result/);
}));

test("retirement preserves result and accepts already-absent pane", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, panes, paneOf }) => {
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  const settled = completeWait(await waitClaude(host, done.workerId, done.submissionId, 10000));
  const retired = await retireClaude(host, done.workerId);
  assert.equal(retired.state, "retired");
  assert.equal(readClaudeWorker(stateDir, done.workerId).task.finalText, settled.finalText);
  const gone = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, gone.workerId, gone.submissionId, 10000));
  present(present(panes.get(paneOf(gone.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(gone.workerId));
  assert.equal((await retireClaude(host, gone.workerId)).state, "retired", "an absent pane counts as closed");
}));

test("changed terminal refuses retirement", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir, panes, paneOf }) => {
  const moved = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, moved.workerId, moved.submissionId, 10000));
  present(panes.get(paneOf(moved.workerId)), "pane").terminal_id = "someone-else";
  await assert.rejects(retireClaude(host, moved.workerId), /identity changed; close refused/);
  assert.equal(readClaudeWorker(stateDir, moved.workerId).state, "open");
}));

test("moved pane ID is neither absent nor closable", { timeout: 30000 }, () => withClaude(async ({ host, spec, panes, paneOf }) => {
  const moved = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, moved.workerId, moved.submissionId, 10000));
  const movedPane = present(panes.get(paneOf(moved.workerId)), "moved pane");
  panes.delete(movedPane.pane_id);
  panes.set("w2:p99", { ...movedPane, pane_id: "w2:p99", workspace_id: "w2" });
  await assert.rejects(retireClaude(host, moved.workerId), /moved or identity changed; close refused/);
}));

test("background job and wake-up hold completion until first empty Stop", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath }) => {
  const deferred = await spawnClaude(host, spec(`SCENARIO:deferred TRANSCRIPT:${tpath("deferred")}`));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const heldFirst = timedOut(await waitClaude(host, deferred.workerId, deferred.submissionId, 1500));
  assert.equal(heldFirst.kind, "timeout", "a Stop with deferred work pending does not settle");
  assert.deepEqual(heldFirst.pending.map((item) => [item.kind, item.tool, item.id]), [["background", "Bash", "tu1"], ["wakeup", "ScheduleWakeup", "tu2"]]);
  const wakeup = present(heldFirst.pending[1], "wakeup");
  const backgroundJob = present(heldFirst.pending[0], "background job");
  assert.ok(wakeup.kind !== "tool" && wakeup.until && backgroundJob.kind !== "tool" && backgroundJob.summary === "npm test");
  writeFileSync(tpath("deferred") + ".go1", "");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const heldSecond = timedOut(await waitClaude(host, deferred.workerId, deferred.submissionId, 1500));
  assert.equal(heldSecond.kind, "timeout", "the wake-up is still pending after the background job finishes");
  assert.deepEqual(heldSecond.pending.map((item) => item.kind), ["wakeup"]);
  writeFileSync(tpath("deferred") + ".go2", "");
  const heldFinal = completeWait(await waitClaude(host, deferred.workerId, deferred.submissionId, 10000));
  assert.equal(heldFinal.finalText, "final report", "the task settles on the first Stop with nothing pending");
}));

test("mid-turn delivered notification allows its Stop to settle", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath }) => {
  const midturn = await spawnClaude(host, spec(`SCENARIO:midturn TRANSCRIPT:${tpath("midturn")}`));
  const midturnResult = completeWait(await waitClaude(host, midturn.workerId, midturn.submissionId, 10000));
  assert.equal(midturnResult.finalText, "verdict posted", JSON.stringify(midturnResult));
}));

test("input after Stop prevents expired monitor settling earlier turn", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath }) => {
  const next = await spawnClaude(host, spec(`SCENARIO:monitornext TRANSCRIPT:${tpath("monitornext")}`));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const nextHeld = timedOut(await waitClaude(host, next.workerId, next.submissionId, 400));
  assert.equal(nextHeld.kind, "timeout", `an earlier Stop never settles once input for the next turn arrived: ${JSON.stringify(nextHeld)}`);
  writeFileSync(tpath("monitornext") + ".go", "");
  assert.equal((completeWait(await waitClaude(host, next.workerId, next.submissionId, 10000))).finalText, "final answer");
}));

test("monitor timeout releases its latest Stop", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath }) => {
  const monitored = await spawnClaude(host, spec(`SCENARIO:monitor TRANSCRIPT:${tpath("monitor")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const watching = timedOut(await waitClaude(host, monitored.workerId, monitored.submissionId, 200));
  assert.deepEqual(watching.pending?.map((item) => item.kind), ["monitor"], JSON.stringify(watching));
  assert.equal((completeWait(await waitClaude(host, monitored.workerId, monitored.submissionId, 10000))).finalText, "watching");
}));

test("deferred task interruption is interrupted", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath }) => {
  const hanging = await spawnClaude(host, spec(`SCENARIO:deferhang TRANSCRIPT:${tpath("hang")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await waitClaude(host, hanging.workerId, hanging.submissionId, 300)).kind, "timeout");
  assert.equal((await interruptClaude(host, hanging.workerId, hanging.submissionId)).outcome, "interrupted");
}));

test("deferred task pane loss is unavailable", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath, panes, paneOf }) => {
  const lostPane = await spawnClaude(host, spec(`SCENARIO:deferhang TRANSCRIPT:${tpath("lost")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  present(present(panes.get(paneOf(lostPane.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(lostPane.workerId));
  const lostPaneResult = completeWait(await waitClaude(host, lostPane.workerId, lostPane.submissionId, 12000));
  assert.equal(lostPaneResult.kind, "unavailable");
  assert.match(present(lostPaneResult.reason, "deferred pane loss reason"), /deferred work pending: background long sleep/);
}));

test("interrupt-caused SessionEnd is interrupted", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath, stateDir, controls, paneOf }) => {
  const idle = await spawnClaude(host, spec(`SCENARIO:idleend TRANSCRIPT:${tpath("idleend")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual((timedOut(await waitClaude(host, idle.workerId, idle.submissionId, 300))).pending.map((item) => item.kind), ["background"]);
  controls.onClose = (paneId) => {
    if (paneId !== paneOf(idle.workerId)) return;
    writeFileSync(join(stateDir, "claude", idle.workerId, "hooks", "SessionEnd-9999999999-1.json"), JSON.stringify({ session_id: "s1", reason: "other" }));
  };
  const idleInterrupt = await interruptClaude(host, idle.workerId, idle.submissionId);
  controls.onClose = undefined;
  assert.equal(idleInterrupt.outcome, "interrupted", "a SessionEnd caused by the interrupt settles interrupted");
  assert.equal(readClaudeWorker(stateDir, idle.workerId).interrupting, false);
}));

test("ordinary SessionEnd while deferred is unavailable", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath, stateDir }) => {
  const ended2 = await spawnClaude(host, spec(`SCENARIO:idleend TRANSCRIPT:${tpath("idleend2")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(join(stateDir, "claude", ended2.workerId, "hooks", "SessionEnd-9999999999-2.json"), JSON.stringify({ session_id: "s1", reason: "other" }));
  assert.equal((completeWait(await waitClaude(host, ended2.workerId, ended2.submissionId, 10000))).kind, "unavailable");
  await interruptClaude(host, ended2.workerId, ended2.submissionId);
}));

test("unreadable transcript prevents Stop settlement and explains pane loss", { timeout: 30000 }, () => withClaude(async ({ host, spec, tpath, panes, paneOf }) => {
  const unreadable = await spawnClaude(host, spec(`SCENARIO:unreadable TRANSCRIPT:${tpath("unreadable")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await waitClaude(host, unreadable.workerId, unreadable.submissionId, 300)).kind, "timeout");
  present(present(panes.get(paneOf(unreadable.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(unreadable.workerId));
  assert.match(present(completeWait(await waitClaude(host, unreadable.workerId, unreadable.submissionId, 12000)).reason, "unreadable transcript reason"), /transcript could not be read/);
}));

test("running tool ledger reports unmatched calls and Stop suppresses calls before summary", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const { at, call, reply } = transcriptEntries();
  const running = await spawnClaude(host, spec("SCENARIO:hang"));
  const runningPath = present(readClaudeWorker(stateDir, running.workerId).task.transcriptPath, "running transcript");
  const append = (entry: unknown) => appendFileSync(runningPath, JSON.stringify(entry) + "\n");
  const waitRunning = async () => timedOut(await waitClaude(host, running.workerId, running.submissionId, 0)).pending;
  append({ timestamp: "2026-09-27T00:00:00.000Z", type: "assistant", message: { content: [{ type: "tool_use", id: "foreground", name: "Bash", input: { command: "sleep 9999" } }] } });
  const foreground = { kind: "tool", tool: "Bash", id: "foreground", startedAt: "2026-09-27T00:00:00.000Z" };
  assert.deepEqual(await waitRunning(), [foreground]);
  assert.deepEqual(await waitRunning(), [foreground]);
  append(reply("foreground", {}));
  assert.deepEqual(await waitRunning(), []);
  append(call("failed-call", "Bash", { command: "false" }));
  assert.deepEqual(await waitRunning(), [{ kind: "tool", tool: "Bash", id: "failed-call", startedAt: at(0) }]);
  append(reply("failed-call", {}, true));
  append(call("parallel-a", "Bash", {}));
  append(call("parallel-b", "Read", {}));
  append(reply("unrelated", {}));
  assert.deepEqual(await waitRunning(), [
    { kind: "tool", tool: "Bash", id: "parallel-a", startedAt: at(0) },
    { kind: "tool", tool: "Read", id: "parallel-b", startedAt: at(0) },
  ]);
  append(reply("parallel-a", {}));
  assert.deepEqual(await waitRunning(), [{ kind: "tool", tool: "Read", id: "parallel-b", startedAt: at(0) }]);
  append({ type: "assistant", message: { content: [{ type: "tool_use", id: "no-time", name: "Bash" }] } });
  append({ timestamp: "bad time", type: "assistant", message: { content: [{ type: "tool_use", id: "bad-time", name: "Bash" },
    { type: "tool_use", id: "", name: "Bash" }, { type: "tool_use", id: "bad-name", name: "" }] } });
  assert.deepEqual(await waitRunning(), [
    { kind: "tool", tool: "Read", id: "parallel-b", startedAt: at(0) },
    { kind: "tool", tool: "Bash", id: "no-time", startedAt: null },
    { kind: "tool", tool: "Bash", id: "bad-time", startedAt: null },
  ]);
  const runningHooks = join(stateDir, "claude", running.workerId, "hooks");
  const stop = (number: number, last_assistant_message: string) => writeFileSync(join(runningHooks, `Stop-${number}-1.json`),
    JSON.stringify({ session_id: "s1", last_assistant_message }));
  const summary = () => append({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] });
  stop(1, "first turn");
  assert.deepEqual(await waitRunning(), []);
  summary();
  assert.equal((completeWait(await waitClaude(host, running.workerId, running.submissionId, 0))).finalText, "first turn");
}));

test("background launches replace running calls and only successful stops end deferred work", { timeout: 30000 }, () => withClaude(async ({ host, spec, stateDir }) => {
  const { at, call, reply } = transcriptEntries();
  const background = await spawnClaude(host, spec("SCENARIO:hang"));
  const backgroundPath = present(readClaudeWorker(stateDir, background.workerId).task.transcriptPath, "background transcript");
  const appendBackground = (entry: unknown) => appendFileSync(backgroundPath, JSON.stringify(entry) + "\n");
  const waitBackground = async () => timedOut(await waitClaude(host, background.workerId, background.submissionId, 0)).pending;
  appendBackground(call("bg", "Bash", { command: "npm test", run_in_background: true }));
  assert.deepEqual(await waitBackground(), [{ kind: "tool", tool: "Bash", id: "bg", startedAt: at(0) }]);
  appendBackground(reply("bg", { backgroundTaskId: "job" }));
  const bgItem = { kind: "background", tool: "Bash", id: "bg", summary: "npm test", until: null };
  assert.deepEqual(await waitBackground(), [bgItem]);
  appendBackground(call("stop-job", "TaskStop", { task_id: "job" }));
  assert.deepEqual(await waitBackground(), [bgItem, { kind: "tool", tool: "TaskStop", id: "stop-job", startedAt: at(0) }]);
  appendBackground(reply("stop-job", {}, true));
  assert.deepEqual(await waitBackground(), [bgItem]);
  appendBackground(call("failed-bg", "Bash", { run_in_background: true }));
  assert.deepEqual(await waitBackground(), [bgItem, { kind: "tool", tool: "Bash", id: "failed-bg", startedAt: at(0) }]);
  appendBackground(reply("failed-bg", {}, true));
  assert.deepEqual(await waitBackground(), [bgItem]);
  appendBackground(call("old", "Read", {}));
  assert.deepEqual(await waitBackground(), [bgItem, { kind: "tool", tool: "Read", id: "old", startedAt: at(0) }]);
  const bgHooks = join(stateDir, "claude", background.workerId, "hooks");
  writeFileSync(join(bgHooks, "Stop-1-1.json"), JSON.stringify({ session_id: "s1", last_assistant_message: "waiting" }));
  appendBackground({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] });
  assert.deepEqual(await waitBackground(), [bgItem]);
  appendBackground(call("current", "Read", {}));
  assert.deepEqual(await waitBackground(), [bgItem, { kind: "tool", tool: "Read", id: "current", startedAt: at(0) }]);
  appendBackground(reply("current", {}));
  appendBackground(call("finish-job", "TaskStop", { task_id: "job" }));
  appendBackground(reply("finish-job", {}));
  writeFileSync(join(bgHooks, "Stop-2-1.json"), JSON.stringify({ session_id: "s1", last_assistant_message: "finished" }));
  appendBackground({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] });
  assert.equal((completeWait(await waitClaude(host, background.workerId, background.submissionId, 0))).finalText, "finished");
}));

test("pending work failed background launch starts nothing", () => {
  const { clock, call, reply } = transcriptEntries();
  assert.deepEqual(pendingWork([call("f1", "Bash", { command: "x", run_in_background: true }), reply("f1", {}, true)], 1, clock), [], "a failed background launch starts nothing");
});

test("pending work failed stop leaves job pending", () => {
  const { clock, job, call, reply } = transcriptEntries();
  assert.equal(pendingWork([...job, call("k1", "TaskStop", { task_id: "b1" }), reply("k1", {}, true)], 3, clock).length, 1, "a failed stop leaves the job pending");
});

test("pending work successful stop ends job", () => {
  const { clock, job, call, reply } = transcriptEntries();
  assert.equal(pendingWork([...job, call("k2", "TaskStop", { task_id: "b1" }), reply("k2", {})], 3, clock).length, 0, "a successful stop ends it");
});

test("pending work queued notification is not delivered", () => {
  const { clock, job, enqueued } = transcriptEntries();
  assert.equal(pendingWork([...job, enqueued], 2, clock).length, 1, "an enqueued notification is not delivered yet, so it finishes nothing for this Stop");
});

test("pending work delivered notification finishes job", () => {
  const { clock, job, notified } = transcriptEntries();
  assert.equal(pendingWork([...job, notified("j1", 500)], 2, clock).length, 0, "a delivered notification finishes the job");
});

test("pending work mid-turn notification finishes job", () => {
  const { clock, job, midTurn, finished } = transcriptEntries();
  assert.equal(pendingWork([...job, midTurn(finished)], 2, clock).length, 0, "a notification delivered mid-turn finishes the job");
});

test("pending work text-block notification finishes job", () => {
  const { clock, job, midTurn, finished } = transcriptEntries();
  assert.equal(pendingWork([...job, midTurn([{ type: "text", text: finished }])], 2, clock).length, 0, "a text-block prompt is read too");
});

test("pending work no-status event does not finish job", () => {
  const { clock, job, midTurn } = transcriptEntries();
  assert.equal(pendingWork([...job, midTurn("<task-notification><tool-use-id>j1</tool-use-id></task-notification>")], 2, clock).length, 1,
    "a streamed event without a status is not completion");
});

test("pending work human prompt finishes nothing", () => {
  const { clock, job, midTurn } = transcriptEntries();
  assert.equal(pendingWork([...job, midTurn("typed by the user: j1 done", "prompt")], 2, clock).length, 1, "a human message mid-turn finishes nothing");
});

test("pending work quoted notification in human prompt finishes nothing", () => {
  const { clock, job, midTurn, finished } = transcriptEntries();
  assert.equal(pendingWork([...job, midTurn(finished, "prompt")], 2, clock).length, 1, "a human message quoting notification markup finishes nothing");
});

test("pending work wrong attachment type is not delivery", () => {
  const { clock, job, finished } = transcriptEntries();
  assert.equal(pendingWork([...job, { type: "attachment", attachment: { type: "prompt_snapshot", prompt: finished } }], 2, clock).length, 1,
    "only a queued_command attachment is a delivery");
});

test("pending work Unicode pending summary truncates at 120 characters", () => {
  const { clock, call, reply } = transcriptEntries();
  const accented = "é".repeat(200);
  assert.equal(present(pendingWork([call("u1", "Bash", { command: accented, run_in_background: true }), reply("u1", { backgroundTaskId: "b2" })], 1, clock)[0], "pending Unicode job").summary, accented.slice(0, 120));
});

test("incremental reader preserves split UTF-8 and isolates shrink by worker", { timeout: 30000 }, () => withClaude(async ({ tpath }) => {
  const readerA = randomUUID(), readerB = randomUUID();
  const partialPath = tpath("partial");
  const line = Buffer.from(JSON.stringify({ type: "user", message: { content: "é" } }) + "\n");
  const cut = line.indexOf(Buffer.from("é")) + 1;
  writeFileSync(partialPath, line.subarray(0, cut));
  assert.deepEqual(readTranscript(readerA, partialPath), []);
  appendFileSync(partialPath, line.subarray(cut));
  assert.equal((() => { const rows = readTranscript(readerA, partialPath); if (rows === "unreadable") throw new Error("partial transcript unreadable"); return present(rows[0], "transcript row").message?.content; })(), "é", "a split multibyte character survives");
  writeFileSync(partialPath, "");
  assert.equal(readTranscript(readerA, partialPath), "unreadable", "a shrunk transcript breaks continuity");
  assert.equal(readTranscript(readerA, partialPath), "unreadable", "and stays broken for that worker");
  assert.deepEqual(readTranscript(readerB, partialPath), [], "another worker's reader is unaffected");
}));

test("listing and cleanup preserve mixed worker states and uncertain launch", { timeout: 60000 }, () => withClaude(async ({ host, spec, controls, herdr, cwd, stateDir, panes, paneOf }) => {
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  const settled = completeWait(await waitClaude(host, done.workerId, done.submissionId, 10000));
  const failed = await spawnClaude(host, spec("SCENARIO:fail"));
  assert.equal(completeWait(await waitClaude(host, failed.workerId, failed.submissionId, 10000)).outcome, "error");
  const ended = await spawnClaude(host, spec("SCENARIO:end"));
  assert.equal(completeWait(await waitClaude(host, ended.workerId, ended.submissionId, 10000)).kind, "unavailable");
  const interrupted = await spawnClaude(host, spec("SCENARIO:hang"));
  assert.equal((await interruptClaude(host, interrupted.workerId, interrupted.submissionId)).outcome, "interrupted");
  const active = await spawnClaude(host, spec("SCENARIO:hang"));

  const changed = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, changed.workerId, changed.submissionId, 10000));
  const changedPane = present(panes.get(paneOf(changed.workerId)), "changed pane");
  changedPane.terminal_id = "someone-else";
  await assert.rejects(retireClaude(host, changed.workerId), /identity changed; close refused/);
  changedPane.terminal_id = readClaudeWorker(stateDir, changed.workerId).terminalId;

  const moved = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, moved.workerId, moved.submissionId, 10000));
  const movedPane = present(panes.get(paneOf(moved.workerId)), "moved pane");
  panes.delete(movedPane.pane_id);
  panes.set("w2:p99", { ...movedPane, pane_id: "w2:p99", workspace_id: "w2" });
  await assert.rejects(retireClaude(host, moved.workerId), /moved or identity changed; close refused/);
  panes.delete("w2:p99");
  panes.set(movedPane.pane_id, movedPane);

  const abort = new AbortController();
  controls.onCreate = () => { controls.onCreate = undefined; const result = herdr(["tab", "create", "--cwd", cwd]); abort.abort(); return result; };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete"), abort.signal), /Cleanup exact new pane closed/);
  const cleanFailedId = present(readdirSync(join(stateDir, "claude")).find(id =>
    JSON.parse(readFileSync(join(stateDir, "claude", id, "launch.json"), "utf8")).cleanup === "exact new pane closed"), "cleaned failed launch");

  const lost = await spawnClaude(host, spec("SCENARIO:hang"));
  await herdr(["pane", "close", paneOf(lost.workerId)]);
  assert.equal(completeWait(await waitClaude(host, lost.workerId, lost.submissionId, 10000)).kind, "unavailable");
  const retired = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, retired.workerId, retired.submissionId, 10000));
  assert.equal((await retireClaude(host, retired.workerId)).state, "retired");

  controls.onCreate = async () => { controls.onCreate = undefined; await herdr(["tab", "create", "--cwd", cwd]); throw new Error("fixture: response lost after creation"); };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Cleanup uncertain: tab creation outcome unknown/);
  const uncertainId = readdirSync(join(stateDir, "claude")).find((id) => {
    try { return JSON.parse(readFileSync(join(stateDir, "claude", id, "launch.json"), "utf8")).cleanup?.startsWith("uncertain: tab creation"); } catch { return false; }
  });
  assert.ok(uncertainId);
  const foreignHost = { ...host, workerId: "stranger" };
  const foreign = await spawnClaude(foreignHost, spec("SCENARIO:complete"));
  const rows = await listClaude(host, (parentId) => parentId === "lead");
  assert.ok(rows.length >= 10 && rows.every((row) => row.kind === "claude_status" && row.task?.finalText === ""));
  assert.deepEqual(await listClaude(host, (parentId) => parentId === "someone-else"), []);
  assert.ok(rows.every(row => row.workerId !== foreign.workerId));
  for (const { workerId, state, kind, outcome } of [
    { workerId: done.workerId, state: "open", kind: "settled", outcome: "completed" },
    { workerId: failed.workerId, state: "open", kind: "settled", outcome: "error" },
    { workerId: ended.workerId, state: "open", kind: "unavailable", outcome: null },
    { workerId: interrupted.workerId, state: "closed", kind: "settled", outcome: "interrupted" },
    { workerId: active.workerId, state: "open", kind: "active", outcome: null },
    { workerId: changed.workerId, state: "open", kind: "settled", outcome: "completed" },
    { workerId: moved.workerId, state: "open", kind: "settled", outcome: "completed" },
    { workerId: cleanFailedId, state: "closed", kind: "unavailable", outcome: null },
    { workerId: lost.workerId, state: "closed", kind: "unavailable", outcome: null },
    { workerId: retired.workerId, state: "closed", kind: "settled", outcome: "completed" },
  ]) {
    const row = present(rows.find(row => row.workerId === workerId), "mixed-state listing row");
    assert.deepEqual({ state: row.state, kind: row.task?.kind, outcome: row.task?.outcome }, { state, kind, outcome });
  }
  for (const row of rows) if (row.state === "open" && row.task.kind !== "active") await retireClaude(host, row.workerId);
  for (const row of rows) if (row.task?.kind === "active") await interruptClaude(host, row.workerId, row.task.submissionId);
  assert.equal(unresolvedClaudeChild(stateDir, (parentId) => parentId === "lead"), uncertainId, "only the uncertain launch still blocks");
  assert.equal(settled.outcome, "completed");
}));

test("invalid effort is rejected", { timeout: 30000 }, () => withClaude(async ({ host, spec }) => {
  const invalidEffort = spec("SCENARIO:complete");
  Reflect.set(invalidEffort, "effort", "minimal");
  await assert.rejects(spawnClaude(host, invalidEffort), /Invalid|Expected|must/i);
}));

test("executable resolves from PATH or absolute override and rejects invalid paths", { timeout: 30000 }, () => withClaude(async ({ root, fakeClaude }) => {
  assert.equal(claudeCommand({ PATH: `/nonexistent:${join(root, "bin")}` }), fakeClaude);
  assert.equal(claudeCommand({ PATH: "", PI_HERDR_CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  assert.throws(() => claudeCommand({ PATH: "/nonexistent" }), /not found on PATH/);
  assert.throws(() => claudeCommand({ PI_HERDR_CLAUDE_BIN: "claude" }), /must be absolute/);
}));

test("launch and settlement produce audit records", { timeout: 30000 }, () => withClaude(async ({ host, spec, audits }) => {
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  const settled = completeWait(await waitClaude(host, done.workerId, done.submissionId, 10000));
  assert.ok(audits.some((entry) => entry.event === "claude_launch") && audits.some((entry) => entry.event === "claude_settlement"));
  assert.equal(settled.outcome, "completed");
}));
