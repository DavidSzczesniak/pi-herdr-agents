// Claude runtime contracts. Herdr is stubbed; the launch script, settings, and hook script are real, and a fake claude
// executable parses options like the real CLI and fires the adapter's own hooks. No model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { present } from "./fakes.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClaudeHost } from "./claude.ts";
import { claudeCommand, interruptClaude, listClaude, pendingWork, readClaudeWorker, readTranscript, retireClaude, spawnClaude, unresolvedClaudeChild, waitClaude } from "./claude.ts";

const root = mkdtempSync("/tmp/piha-claude-");
const stateDir = join(root, "state");
for (const dir of ["", "artifacts", "claude"]) mkdirSync(join(stateDir, dir), { recursive: true, mode: 0o700 });
const cwd = join(root, "repo");
mkdirSync(cwd);

const fakeClaude = join(root, "bin", "claude");
mkdirSync(join(root, "bin"));
writeFileSync(fakeClaude, `#!${process.execPath}
const { execSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
// Parse like the real CLI: variadic options consume values until the next option, and "--" ends option parsing.
const variadic = new Set(["--add-dir", "--disallowed-tools"]);
const single = new Set(["--setting-sources", "--settings", "--append-system-prompt", "--permission-mode", "--model", "--effort"]);
const options = {}; const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") { positional.push(...args.slice(i + 1)); break; }
  if (variadic.has(arg)) { options[arg] = []; while (i + 1 < args.length && !args[i + 1].startsWith("-")) options[arg].push(args[++i]); continue; }
  if (single.has(arg)) { options[arg] = args[++i]; continue; }
  if (arg === "--strict-mcp-config") { options[arg] = true; continue; }
  if (arg.startsWith("-")) throw new Error("unknown option " + arg);
  positional.push(arg);
}
if (positional.length !== 1) throw new Error("expected exactly one prompt, got " + positional.length);
if (options["--setting-sources"] !== "" || options["--strict-mcp-config"] !== true) throw new Error("session not isolated");
if (options["--add-dir"]?.length !== 1 || options["--permission-mode"] !== "bypassPermissions") throw new Error("bad directory or permission options");
if (options["--disallowed-tools"]?.join(",") !== "Agent,Task,AskUserQuestion") throw new Error("leaf tools not disabled");
if (process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== undefined) throw new Error("background tasks must stay available");
if (!/No human watches.*You cannot start other agents/.test(options["--append-system-prompt"])) throw new Error("worker brief missing");
let prompt = positional[0];
const pointer = /^Your complete task brief is in (\\S+)\\. /.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], "utf8");
const hooks = JSON.parse(readFileSync(options["--settings"], "utf8")).hooks;
// Like Claude Code, every session has a transcript, and each own-session Stop is followed by its summary line.
const transcript = /TRANSCRIPT:(\\S+)/.exec(prompt)?.[1] ?? require("node:path").join(options["--add-dir"][0], "transcript.jsonl");
require("node:fs").appendFileSync(transcript, "");
const summary = () => require("node:fs").appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: "system",
  subtype: "stop_hook_summary", hookInfos: [{ command: hooks.Stop[0].hooks[0].command }] }) + "\\n");
const fire = (event, input) => {
  const body = { hook_event_name: event, session_id: "s1", transcript_path: transcript, ...input };
  execSync(hooks[event][0].hooks[0].command, { input: JSON.stringify(body) });
  if (event === "Stop" && body.session_id === "s1") summary();
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const scenario = /SCENARIO:(\\w+)/.exec(prompt)?.[1];
// Deferred-work scenarios write a real transcript in Claude Code's shape and gate each later turn on a file the test creates.
const { appendFileSync, existsSync } = require("node:fs");
const log = (entry) => appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\\n");
const use = (id, name, input) => log({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, toolUseResult) => log({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult });
const turnEnd = (message) => fire("Stop", { last_assistant_message: message });
const gate = (name) => { while (!existsSync(transcript + "." + name)) pause(20); };
if (scenario === "trust") { console.log("Quick safety check: Yes, I trust this folder"); setInterval(() => {}, 1000); }
else {
  fire("UserPromptSubmit", { prompt });
  const report = "model=" + options["--model"] + " effort=" + options["--effort"] + " apiKey=" + (process.env.ANTHROPIC_API_KEY ?? "unset") +
    " bedrock=" + (process.env.CLAUDE_CODE_USE_BEDROCK ?? "unset") + " bytes=" + prompt.length;
  if (scenario === "complete") fire("Stop", { last_assistant_message: "done " + report });
  else if (scenario === "twice") { fire("Stop", { last_assistant_message: "first turn" }); pause(30); fire("Stop", { last_assistant_message: "second turn" }); }
  else if (scenario === "othersession") { fire("Stop", { session_id: "s2", last_assistant_message: "other session" }); pause(30); fire("Stop", { last_assistant_message: "own session" }); }
  else if (scenario === "fail") fire("StopFailure", { error: "rate_limit" });
  else if (scenario === "hugefail") fire("StopFailure", { error: "E".repeat(100000) });
  else if (scenario === "overlap") {
    const { spawn } = require("node:child_process");
    for (const message of ["overlap a", "overlap b"]) {
      const child = spawn("sh", ["-c", hooks.Stop[0].hooks[0].command]);
      child.stdin.end(JSON.stringify({ session_id: "s1", transcript_path: transcript, last_assistant_message: message }));
      child.on("exit", summary);
    }
  }
  else if (scenario === "end") fire("SessionEnd", { reason: "logout" });
  else if (scenario === "deferred") {
    use("tu1", "Bash", { command: "npm test", run_in_background: true }); result("tu1", { backgroundTaskId: "bt1" });
    use("tu2", "ScheduleWakeup", { delaySeconds: 1200, prompt: "check the log" }); result("tu2", { scheduledFor: Date.now() + 1200000 });
    turnEnd("still running");
    gate("go1");
    log({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\\n<task-id>bt1</task-id>\\n<tool-use-id>tu1</tool-use-id>\\n<status>completed</status>\\n</task-notification>" });
    log({ type: "user", message: { content: "<task-notification>\\n<task-id>bt1</task-id>\\n<tool-use-id>tu1</tool-use-id>\\n<status>completed</status>\\n</task-notification>" } });
    fire("UserPromptSubmit", { transcript_path: transcript, prompt: "notification" });
    log({ type: "assistant", message: { content: [{ type: "text", text: "report" }] } });
    turnEnd("report after test");
    gate("go2");
    log({ type: "system", subtype: "scheduled_task_fire", content: "Claude resuming /loop wakeup" });
    fire("UserPromptSubmit", { transcript_path: transcript, prompt: "check the log" });
    log({ type: "assistant", message: { content: [{ type: "text", text: "final" }] } });
    turnEnd("final report");
  }
  else if (scenario === "midturn") {
    // The #150 reviewer: a background job finishes while the turn is still running, so Claude receives its notification
    // as a queued_command attachment inside that turn, then ends the turn with nothing pending.
    const notice = "<task-notification>\\n<task-id>bm7</task-id>\\n<tool-use-id>tm7</tool-use-id>\\n<status>completed</status>\\n</task-notification>";
    use("tm7", "Bash", { command: "npm run release -- prepare", run_in_background: true }); result("tm7", { backgroundTaskId: "bm7" });
    log({ type: "queue-operation", operation: "enqueue", content: notice });
    log({ type: "queue-operation", operation: "remove", content: notice });
    log({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt: notice } });
    log({ type: "assistant", message: { content: [{ type: "text", text: "verdict posted" }] } });
    turnEnd("verdict posted");
  }
  else if (scenario === "monitornext") {
    // A mid-turn notification after the Stop starts the next turn, so the expired monitor no longer settles the earlier Stop.
    use("tn1", "Monitor", { command: "tail -f log", description: "watch", timeout_ms: 300 }); result("tn1", { taskId: "bn1" });
    turnEnd("interim answer");
    log({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification",
      prompt: "<task-notification><task-id>bn1</task-id><tool-use-id>tn1</tool-use-id><event>line</event></task-notification>" } });
    gate("go");
    log({ type: "assistant", message: { content: [{ type: "text", text: "final" }] } });
    turnEnd("final answer");
  }
  else if (scenario === "idleend") {
    use("ti1", "Bash", { command: "sleep 9999", description: "idle sleep", run_in_background: true }); result("ti1", { backgroundTaskId: "bi1" });
    turnEnd("waiting");
  }
  else if (scenario === "unreadable") { turnEnd("interim"); require("node:fs").rmSync(transcript); }
  else if (scenario === "monitor") {
    use("tm1", "Monitor", { command: "tail -f log", description: "watch the log", timeout_ms: 4000 }); result("tm1", { taskId: "bm1" });
    turnEnd("watching");
  }
  else if (scenario === "deferhang") {
    use("th1", "Bash", { command: "sleep 9999", description: "long sleep", run_in_background: true }); result("th1", { backgroundTaskId: "bh1" });
    turnEnd("waiting on sleep");
  }
  setInterval(() => {}, 1000);
}
`);
chmodSync(fakeClaude, 0o755);

// Herdr stub: `pane run` starts a real shell process in the pane. A tab can hold more than one pane.
type Pane = { pane_id: string; workspace_id: string; tab_id: string; terminal_id: string; cwd: string; output: string; child?: ChildProcessWithoutNullStreams };
const panes = new Map<string, Pane>();
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
    pane.child = spawn("sh", ["-c", present(args[3], "pane command")], { cwd: pane.cwd, env: { ...process.env, ANTHROPIC_API_KEY: "leaked", CLAUDE_CODE_USE_BEDROCK: "1" } });
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
    pane?.child?.kill("SIGKILL");
    panes.delete(present(args[2], "pane id"));
    // Runs after the pane is gone and before the close returns, like a real close still being confirmed.
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
const completeWait = (result: Awaited<ReturnType<typeof waitClaude>>) => { if (result.kind === "timeout") throw new Error(`Claude wait timed out: ${JSON.stringify(result)}`); return result; };
const timedOut = (result: Awaited<ReturnType<typeof waitClaude>>) => { if (result.kind !== "timeout") throw new Error(`expected Claude timeout, got ${result.kind}`); return result; };

try {
  mkdirSync(join(host.stateDir, "operations"), { recursive: true });
  // Completion: acceptance from UserPromptSubmit, settlement from Stop, credentials and provider routing unset, isolated leaf session.
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
  assert.ok(Buffer.byteLength(present(present(herdrCalls.find((args) => args[1] === "run"), "run command")[3], "exec line")) < 1024, "Herdr types only a short exec line");
  await assert.rejects(waitClaude(host, done.workerId, "other-submission", 1000), /Unknown submission/);

  // A brief that looks like an option stays the prompt.
  const dashed = await spawnClaude(host, spec("--settings=/tmp/evil.json --help SCENARIO:complete"));
  assert.equal((completeWait(await waitClaude(host, dashed.workerId, dashed.submissionId, 10000))).outcome, "completed");

  // Oversized briefs arrive by file pointer and still complete.
  const large = await spawnClaude(host, spec("x".repeat(130000) + " SCENARIO:complete"));
  const largeResult = completeWait(await waitClaude(host, large.workerId, large.submissionId, 10000));
  assert.match(largeResult.finalText, /bytes=130018$/, "the worker read the whole brief from the file");

  // The first terminal event of the accepted session wins; later turns and other sessions do not replace it.
  const twice = await spawnClaude(host, spec("SCENARIO:twice"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((completeWait(await waitClaude(host, twice.workerId, twice.submissionId, 10000))).finalText, "first turn");
  assert.equal(readdirSync(join(stateDir, "claude", twice.workerId, "hooks")).filter((name) => name.startsWith("Stop-")).length, 2,
    "each hook invocation keeps its own file");
  const other = await spawnClaude(host, spec("SCENARIO:othersession"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((completeWait(await waitClaude(host, other.workerId, other.submissionId, 10000))).finalText, "own session");

  // Provider failure and session end without a result are distinct outcomes.
  const failed = await spawnClaude(host, spec("SCENARIO:fail"));
  const failure = completeWait(await waitClaude(host, failed.workerId, failed.submissionId, 10000));
  assert.equal(failure.outcome, "error");
  assert.equal(failure.reason, "rate_limit");
  const ended = await spawnClaude(host, spec("SCENARIO:end"));
  const end = completeWait(await waitClaude(host, ended.workerId, ended.submissionId, 10000));
  assert.equal(end.kind, "unavailable");
  assert.match(present(end.reason, "session end reason"), /ended without a result \(logout\)/);

  // A trust dialog is never answered: the launch fails fast with an instruction and closes its exact pane.
  const trustStarted = Date.now();
  await assert.rejects(spawnClaude(host, spec("SCENARIO:trust"), undefined, 60000), /does not trust .*trust it, then retry.*Cleanup exact new pane closed/s);
  assert.ok(Date.now() - trustStarted < 15000, "a trust dialog fails fast instead of waiting out the startup deadline");

  // Cancellation after tab creation still closes the exact created pane; a lost creation response stays explicit.
  const abort = new AbortController();
  onCreate = () => { onCreate = undefined; const result = herdr(["tab", "create", "--cwd", cwd]); abort.abort(); return result; };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete"), abort.signal), /Cleanup exact new pane closed/);
  onCreate = () => { onCreate = undefined; throw new Error("fixture: creation response lost"); };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Cleanup uncertain: tab creation outcome unknown/);

  // An overlong launch line is refused before any tab exists.
  const deepHost = { ...host, stateDir: join(stateDir, "d".repeat(250), "e".repeat(250), "f".repeat(250), "g".repeat(250)) };
  const before = herdrCalls.length;
  await assert.rejects(spawnClaude(deepHost, spec("SCENARIO:complete")), /launch line too long/);
  assert.equal(herdrCalls.length, before);

  // Overlapping hook invocations each keep a complete file, and the result is one of them.
  const overlap = await spawnClaude(host, spec("SCENARIO:overlap"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const overlapResult = completeWait(await waitClaude(host, overlap.workerId, overlap.submissionId, 10000));
  assert.ok(["overlap a", "overlap b"].includes(overlapResult.finalText));
  const overlapHooks = readdirSync(join(stateDir, "claude", overlap.workerId, "hooks"));
  assert.equal(overlapHooks.filter((name) => name.startsWith("Stop-")).length, 2);
  assert.ok(!overlapHooks.some((name) => name.endsWith(".tmp")));

  // Concurrent observers agree and settle once.
  const shared = await spawnClaude(host, spec("SCENARIO:complete"));
  const [first, second] = await Promise.all([waitClaude(host, shared.workerId, shared.submissionId, 10000), waitClaude(host, shared.workerId, shared.submissionId, 10000)]);
  assert.deepEqual(first, second);
  assert.equal(audits.filter((entry) => entry.event === "claude_settlement" && (typeof entry.data === "object" && entry.data !== null && "claudeWorkerId" in entry.data ? entry.data.claudeWorkerId : undefined) === shared.workerId).length, 1);

  // Oversized error text is capped and still returns.
  const huge = await spawnClaude(host, spec("SCENARIO:hugefail"));
  const hugeResult = completeWait(await waitClaude(host, huge.workerId, huge.submissionId, 10000));
  assert.equal(hugeResult.outcome, "error");
  assert.equal(present(hugeResult.reason, "oversized error").length, 4000);

  // A detached runtime never writes: waits and transitions refuse.
  const late = await spawnClaude(host, spec("SCENARIO:hang"));
  detached = true;
  await assert.rejects(waitClaude(host, late.workerId, late.submissionId, 2000), /Worker unavailable/);
  detached = false;

  // A server-side tab whose creation response was lost keeps blocking parent retirement.
  onCreate = async () => { onCreate = undefined; await herdr(["tab", "create", "--cwd", cwd]); throw new Error("fixture: response lost after creation"); };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Cleanup uncertain: tab creation outcome unknown/);
  const uncertainId = readdirSync(join(stateDir, "claude")).find((id) => {
    try { return JSON.parse(readFileSync(join(stateDir, "claude", id, "launch.json"), "utf8")).cleanup?.startsWith("uncertain: tab creation"); } catch { return false; }
  });
  assert.ok(uncertainId);

  // A running task times out without settling and cannot be retired.
  const hung = await spawnClaude(host, spec("SCENARIO:hang"));
  assert.deepEqual(await waitClaude(host, hung.workerId, hung.submissionId, 1500),
    { kind: "timeout", runtime: "claude", workerId: hung.workerId, submissionId: hung.submissionId, active: true, pending: [] });
  await assert.rejects(retireClaude(host, hung.workerId), /active task/);
  assert.ok(unresolvedClaudeChild(stateDir, (parentId) => parentId === "lead"), "open or active Claude children block parent retirement");
  assert.equal(unresolvedClaudeChild(stateDir, (parentId) => parentId === "someone-else"), undefined);

  // Interrupt closes only its own pane in a split tab; the other pane survives.
  const hungPane = readClaudeWorker(stateDir, hung.workerId);
  panes.set("w1:split", { pane_id: "w1:split", workspace_id: "w1", tab_id: hungPane.tabId, terminal_id: "term-split", cwd, output: "" });
  const interrupted = await interruptClaude(host, hung.workerId, hung.submissionId);
  assert.equal(interrupted.outcome, "interrupted");
  assert.ok(!panes.has(hungPane.paneId) && panes.has("w1:split"), "only the exact Claude pane closed");
  assert.equal(readClaudeWorker(stateDir, hung.workerId).state, "closed");

  // Evidence that lands during the interrupt's close wins over the interruption.
  const racing = await spawnClaude(host, spec("SCENARIO:hang"));
  onClose = (paneId) => {
    if (paneId !== paneOf(racing.workerId)) return;
    writeFileSync(join(stateDir, "claude", racing.workerId, "hooks", "Stop-1-1.json"), JSON.stringify({ session_id: "s1", last_assistant_message: "finished first" }));
    appendFileSync(join(stateDir, "claude", racing.workerId, "transcript.jsonl"), JSON.stringify({ type: "system", subtype: "stop_hook_summary",
      hookInfos: [{ command: "'/bin/sh' '/x/claude-hook.sh' 'Stop' '/x'" }] }) + "\n");
  };
  const raced = await interruptClaude(host, racing.workerId, racing.submissionId);
  onClose = undefined;
  assert.equal(raced.outcome, "completed");
  assert.equal(raced.finalText, "finished first");
  assert.equal(readClaudeWorker(stateDir, racing.workerId).interrupting, false, "a result settled during the close clears the interrupt flag");

  // A wait that observes the pane mid-interrupt does not record the close as a lost pane.
  const contested = await spawnClaude(host, spec("SCENARIO:hang"));
  let observed: Awaited<ReturnType<typeof completeWait>> | undefined;
  onClose = async (paneId) => {
    if (paneId === paneOf(contested.workerId)) observed = completeWait(await waitClaude(host, contested.workerId, contested.submissionId, 3000));
  };
  const contestedResult = await interruptClaude(host, contested.workerId, contested.submissionId);
  onClose = undefined;
  assert.equal(present(observed, "interrupt observation").outcome, "interrupted", "an observer that sees the pane gone mid-interrupt records the interruption");
  assert.equal(contestedResult.outcome, "interrupted");

  // An interrupter that dies after closing the pane leaves an interruption, not a task that stays active.
  const orphaned = await spawnClaude(host, spec("SCENARIO:hang"));
  const orphanedPath = join(stateDir, "claude", orphaned.workerId, "worker.json");
  writeFileSync(orphanedPath, JSON.stringify({ ...JSON.parse(readFileSync(orphanedPath, "utf8")), interrupting: true }));
  present(present(panes.get(paneOf(orphaned.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(orphaned.workerId));
  assert.equal((completeWait(await waitClaude(host, orphaned.workerId, orphaned.submissionId, 3000))).outcome, "interrupted");

  // Detachment during launch acceptance still leaves a failed receipt after closing the exact pane.
  onRun = () => { onRun = undefined; detached = true; };
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete")), /Worker unavailable/);
  detached = false;
  const detachedLaunch = readdirSync(join(stateDir, "claude")).map((id) => JSON.parse(readFileSync(join(stateDir, "claude", id, "launch.json"), "utf8")))
    .find((receipt) => receipt.error?.includes("Worker unavailable"));
  assert.equal(detachedLaunch.kind, "failed");
  assert.match(detachedLaunch.cleanup, /^exact new pane closed; worker record not updated/);

  // A pane lost without a result settles unavailable instead of staying active forever.
  const lost = await spawnClaude(host, spec("SCENARIO:hang"));
  present(present(panes.get(paneOf(lost.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(lost.workerId));
  const lostResult = completeWait(await waitClaude(host, lost.workerId, lost.submissionId, 5000));
  assert.equal(lostResult.kind, "unavailable");
  assert.match(present(lostResult.reason, "lost pane reason"), /closed without a result/);

  // Retirement closes the exact pane, keeps results, accepts an already-absent pane, and refuses a changed pane.
  const retired = await retireClaude(host, done.workerId);
  assert.equal(retired.state, "retired");
  assert.equal(readClaudeWorker(stateDir, done.workerId).task.finalText, settled.finalText);
  const gone = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, gone.workerId, gone.submissionId, 10000));
  present(present(panes.get(paneOf(gone.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(gone.workerId));
  assert.equal((await retireClaude(host, gone.workerId)).state, "retired", "an absent pane counts as closed");
  const moved = await spawnClaude(host, spec("SCENARIO:complete"));
  completeWait(await waitClaude(host, moved.workerId, moved.submissionId, 10000));
  present(panes.get(paneOf(moved.workerId)), "pane").terminal_id = "someone-else";
  await assert.rejects(retireClaude(host, moved.workerId), /identity changed; close refused/);
  assert.equal(readClaudeWorker(stateDir, moved.workerId).state, "open");
  present(panes.get(paneOf(moved.workerId)), "pane").terminal_id = readClaudeWorker(stateDir, moved.workerId).terminalId;
  // A pane moved to a new ID still holds the terminal: neither absent nor closable.
  const movedPane = present(panes.get(paneOf(moved.workerId)), "moved pane");
  panes.delete(movedPane.pane_id);
  panes.set("w2:p99", { ...movedPane, pane_id: "w2:p99", workspace_id: "w2" });
  await assert.rejects(retireClaude(host, moved.workerId), /moved or identity changed; close refused/);
  panes.delete("w2:p99");
  panes.set(movedPane.pane_id, movedPane);

  // Deferred work: a Stop with a background job or wake-up pending keeps the task active and reports what is pending.
  mkdirSync(join(root, "transcripts"));
  const tpath = (name: string) => join(root, "transcripts", `${name}.jsonl`);
  const deferred = await spawnClaude(host, spec(`SCENARIO:deferred TRANSCRIPT:${tpath("deferred")}`));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const heldFirst = timedOut(await waitClaude(host, deferred.workerId, deferred.submissionId, 1500));
  assert.equal(heldFirst.kind, "timeout", "a Stop with deferred work pending does not settle");
  assert.deepEqual(heldFirst.pending.map((item) => [item.kind, item.tool, item.id]), [["background", "Bash", "tu1"], ["wakeup", "ScheduleWakeup", "tu2"]]);
  assert.ok(present(heldFirst.pending[1], "wakeup").until && present(heldFirst.pending[0], "background job").summary === "npm test");
  writeFileSync(tpath("deferred") + ".go1", "");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const heldSecond = timedOut(await waitClaude(host, deferred.workerId, deferred.submissionId, 1500));
  assert.equal(heldSecond.kind, "timeout", "the wake-up is still pending after the background job finishes");
  assert.deepEqual(heldSecond.pending.map((item) => item.kind), ["wakeup"]);
  writeFileSync(tpath("deferred") + ".go2", "");
  const heldFinal = completeWait(await waitClaude(host, deferred.workerId, deferred.submissionId, 10000));
  assert.equal(heldFinal.finalText, "final report", "the task settles on the first Stop with nothing pending");
  // A job that finishes mid-turn is delivered inside that turn, so the turn's Stop settles the task.
  const midturn = await spawnClaude(host, spec(`SCENARIO:midturn TRANSCRIPT:${tpath("midturn")}`));
  const midturnResult = completeWait(await waitClaude(host, midturn.workerId, midturn.submissionId, 10000));
  assert.equal(midturnResult.finalText, "verdict posted", JSON.stringify(midturnResult));
  const next = await spawnClaude(host, spec(`SCENARIO:monitornext TRANSCRIPT:${tpath("monitornext")}`));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const nextHeld = timedOut(await waitClaude(host, next.workerId, next.submissionId, 400));
  assert.equal(nextHeld.kind, "timeout", `an earlier Stop never settles once input for the next turn arrived: ${JSON.stringify(nextHeld)}`);
  writeFileSync(tpath("monitornext") + ".go", "");
  assert.equal((completeWait(await waitClaude(host, next.workerId, next.submissionId, 10000))).finalText, "final answer");
  // A monitor counts as pending only until its timeout, since it can end without a marker.
  const monitored = await spawnClaude(host, spec(`SCENARIO:monitor TRANSCRIPT:${tpath("monitor")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const watching = timedOut(await waitClaude(host, monitored.workerId, monitored.submissionId, 200));
  assert.deepEqual(watching.pending?.map((item) => item.kind), ["monitor"], JSON.stringify(watching));
  assert.equal((completeWait(await waitClaude(host, monitored.workerId, monitored.submissionId, 10000))).finalText, "watching");
  // Interrupting a worker that waits on deferred work is an interruption; a pane lost while waiting is unavailable.
  const hanging = await spawnClaude(host, spec(`SCENARIO:deferhang TRANSCRIPT:${tpath("hang")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await waitClaude(host, hanging.workerId, hanging.submissionId, 300)).kind, "timeout");
  assert.equal((await interruptClaude(host, hanging.workerId, hanging.submissionId)).outcome, "interrupted");
  const lostPane = await spawnClaude(host, spec(`SCENARIO:deferhang TRANSCRIPT:${tpath("lost")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  present(present(panes.get(paneOf(lostPane.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(lostPane.workerId));
  const lostPaneResult = completeWait(await waitClaude(host, lostPane.workerId, lostPane.submissionId, 12000));
  assert.equal(lostPaneResult.kind, "unavailable");
  assert.match(present(lostPaneResult.reason, "deferred pane loss reason"), /deferred work pending: background long sleep/);

  // Closing an idle worker's pane ends its session cleanly; that SessionEnd is the interrupt's effect, not a lost result.
  const idle = await spawnClaude(host, spec(`SCENARIO:idleend TRANSCRIPT:${tpath("idleend")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual((timedOut(await waitClaude(host, idle.workerId, idle.submissionId, 300))).pending.map((item) => item.kind), ["background"]);
  onClose = (paneId) => {
    if (paneId !== paneOf(idle.workerId)) return;
    writeFileSync(join(stateDir, "claude", idle.workerId, "hooks", "SessionEnd-9999999999-1.json"), JSON.stringify({ session_id: "s1", reason: "other" }));
  };
  const idleInterrupt = await interruptClaude(host, idle.workerId, idle.submissionId);
  onClose = undefined;
  assert.equal(idleInterrupt.outcome, "interrupted", "a SessionEnd caused by the interrupt settles interrupted");
  assert.equal(readClaudeWorker(stateDir, idle.workerId).interrupting, false);
  // Without an interrupt, the same SessionEnd is still a session that ended without a result.
  const ended2 = await spawnClaude(host, spec(`SCENARIO:idleend TRANSCRIPT:${tpath("idleend2")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(join(stateDir, "claude", ended2.workerId, "hooks", "SessionEnd-9999999999-2.json"), JSON.stringify({ session_id: "s1", reason: "other" }));
  assert.equal((completeWait(await waitClaude(host, ended2.workerId, ended2.submissionId, 10000))).kind, "unavailable");
  await interruptClaude(host, ended2.workerId, ended2.submissionId).catch(() => {});

  // A Stop whose transcript cannot be read proves nothing: it never settles, and a lost pane says why.
  const unreadable = await spawnClaude(host, spec(`SCENARIO:unreadable TRANSCRIPT:${tpath("unreadable")}`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await waitClaude(host, unreadable.workerId, unreadable.submissionId, 300)).kind, "timeout");
  present(present(panes.get(paneOf(unreadable.workerId)), "pane").child, "pane process").kill("SIGKILL");
  panes.delete(paneOf(unreadable.workerId));
  assert.match(present(completeWait(await waitClaude(host, unreadable.workerId, unreadable.submissionId, 12000)).reason, "unreadable transcript reason"), /transcript could not be read/);
  // Only a successful call starts or stops deferred work, and a completion after the Stop hook fired belongs to a later turn.
  const clock = Date.now();
  const at = (offset: number) => new Date(clock + offset).toISOString();
  const call = (id: string, name: string, input: Record<string, unknown>, offset = 0) => ({ timestamp: at(offset), type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const reply = (id: string, toolUseResult: Record<string, unknown>, isError = false, offset = 0) => ({ timestamp: at(offset), type: "user", toolUseResult,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: isError }] } });
  const notified = (id: string, offset: number) => ({ timestamp: at(offset), type: "user", message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>` } });
  assert.deepEqual(pendingWork([call("f1", "Bash", { command: "x", run_in_background: true }), reply("f1", {}, true)], 1, clock), [], "a failed background launch starts nothing");
  const job = [call("j1", "Bash", { command: "npm test", run_in_background: true }), reply("j1", { backgroundTaskId: "b1" })];
  assert.equal(pendingWork([...job, call("k1", "TaskStop", { task_id: "b1" }), reply("k1", {}, true)], 3, clock).length, 1, "a failed stop leaves the job pending");
  assert.equal(pendingWork([...job, call("k2", "TaskStop", { task_id: "b1" }), reply("k2", {})], 3, clock).length, 0, "a successful stop ends it");
  const enqueued = { type: "queue-operation", operation: "enqueue", content: "<task-notification><tool-use-id>j1</tool-use-id><status>completed</status></task-notification>" };
  assert.equal(pendingWork([...job, enqueued], 2, clock).length, 1, "an enqueued notification is not delivered yet, so it finishes nothing for this Stop");
  assert.equal(pendingWork([...job, notified("j1", 500)], 2, clock).length, 0, "a delivered notification finishes the job");
  const midTurn = (prompt: string | { type: string; text: string }[], commandMode = "task-notification") => ({ type: "attachment", attachment: { type: "queued_command", prompt, commandMode } });
  const finished = "<task-notification><tool-use-id>j1</tool-use-id><status>completed</status></task-notification>";
  assert.equal(pendingWork([...job, midTurn(finished)], 2, clock).length, 0, "a notification delivered mid-turn finishes the job");
  assert.equal(pendingWork([...job, midTurn([{ type: "text", text: finished }])], 2, clock).length, 0, "a text-block prompt is read too");
  assert.equal(pendingWork([...job, midTurn("<task-notification><tool-use-id>j1</tool-use-id></task-notification>")], 2, clock).length, 1,
    "a streamed event without a status is not completion");
  assert.equal(pendingWork([...job, midTurn("typed by the user: j1 done", "prompt")], 2, clock).length, 1, "a human message mid-turn finishes nothing");
  assert.equal(pendingWork([...job, midTurn(finished, "prompt")], 2, clock).length, 1, "a human message quoting notification markup finishes nothing");
  assert.equal(pendingWork([...job, { type: "attachment", attachment: { type: "prompt_snapshot", prompt: finished } }], 2, clock).length, 1,
    "only a queued_command attachment is a delivery");
  const accented = "é".repeat(200);
  assert.equal(present(pendingWork([call("u1", "Bash", { command: accented, run_in_background: true }), reply("u1", { backgroundTaskId: "b2" })], 1, clock)[0], "pending Unicode job").summary, accented.slice(0, 120));

  // The reader parses only appended bytes, keeps a character split across reads, and breaks continuity per worker on a shrink.
  const partialPath = tpath("partial");
  const line = Buffer.from(JSON.stringify({ type: "user", message: { content: "é" } }) + "\n");
  const cut = line.indexOf(Buffer.from("é")) + 1;
  writeFileSync(partialPath, line.subarray(0, cut));
  assert.deepEqual(readTranscript("wa", partialPath), []);
  appendFileSync(partialPath, line.subarray(cut));
  assert.equal((() => { const rows = readTranscript("wa", partialPath); if (rows === "unreadable") throw new Error("partial transcript unreadable"); return present(rows[0], "transcript row").message?.content; })(), "é", "a split multibyte character survives");
  writeFileSync(partialPath, "");
  assert.equal(readTranscript("wa", partialPath), "unreadable", "a shrunk transcript breaks continuity");
  assert.equal(readTranscript("wa", partialPath), "unreadable", "and stays broken for that worker");
  assert.deepEqual(readTranscript("wb", partialPath), [], "another worker's reader is unaffected");

  // Listing reports owned workers without final text; retiring the rest clears the parent-retirement block.
  const rows = await listClaude(host, (parentId) => parentId === "lead");
  assert.ok(rows.length >= 10 && rows.every((row) => row.kind === "claude_status" && row.task?.finalText === ""));
  assert.deepEqual(await listClaude(host, (parentId) => parentId === "someone-else"), []);
  for (const row of rows) if (row.state === "open" && row.task.kind !== "active") await retireClaude(host, row.workerId);
  for (const row of rows) if (row.task?.kind === "active") await interruptClaude(host, row.workerId, row.task.submissionId);
  assert.equal(unresolvedClaudeChild(stateDir, (parentId) => parentId === "lead"), uncertainId, "only the uncertain launch still blocks");

  // Effort outside Claude's levels is refused; the executable resolves from PATH or an absolute override.
  const invalidEffort = spec("SCENARIO:complete");
  Reflect.set(invalidEffort, "effort", "minimal");
  await assert.rejects(spawnClaude(host, invalidEffort), /Invalid|Expected|must/i);
  assert.equal(claudeCommand({ PATH: `/nonexistent:${join(root, "bin")}` }), fakeClaude);
  assert.equal(claudeCommand({ PATH: "", PI_HERDR_CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  assert.throws(() => claudeCommand({ PATH: "/nonexistent" }), /not found on PATH/);
  assert.throws(() => claudeCommand({ PI_HERDR_CLAUDE_BIN: "claude" }), /must be absolute/);
  assert.ok(audits.some((entry) => entry.event === "claude_launch") && audits.some((entry) => entry.event === "claude_settlement"));
  console.log("PASS Claude runtime module: interrupt versus observer mid-close, abandoned interrupts, detachment during launch, overlapping hooks, concurrent observers, capped errors, detached-runtime refusal, uncertain creation blocking, moved panes, hook acceptance and first-terminal settlement, deferred background jobs, wake-ups and monitors held open and reported, interrupt and pane loss while deferred, unreadable transcripts, failed deferred calls, undelivered notifications, session correlation, option-safe and file-pointer briefs, isolated leaf flags, unset API keys, error and session-end outcomes, trust refusal, cancelled and lost tab creation, launch-line limit, exact-pane interrupt and retirement in split tabs, interrupt race, lost panes, parent-retirement blocking, listing, effort validation, executable resolution. Herdr stubbed; fake claude; no model calls.");
} finally {
  for (const pane of panes.values()) pane.child?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
