// Claude runtime contracts. Herdr is stubbed; the launch script, settings, and hook script are real, and a fake claude
// executable parses options like the real CLI and fires the adapter's own hooks. No model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCommand, interruptClaude, listClaude, readClaudeWorker, retireClaude, spawnClaude, unresolvedClaudeChild, waitClaude } from "./claude.ts";

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
if (!/No human watches.*You cannot start other agents/.test(options["--append-system-prompt"])) throw new Error("worker brief missing");
let prompt = positional[0];
const pointer = /^Your complete task brief is in (\\S+)\\. /.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], "utf8");
const hooks = JSON.parse(readFileSync(options["--settings"], "utf8")).hooks;
const fire = (event, input) => execSync(hooks[event][0].hooks[0].command, { input: JSON.stringify({ hook_event_name: event, session_id: "s1", transcript_path: "/tmp/t.jsonl", ...input }) });
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const scenario = /SCENARIO:(\\w+)/.exec(prompt)?.[1];
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
      child.stdin.end(JSON.stringify({ session_id: "s1", last_assistant_message: message }));
    }
  }
  else if (scenario === "end") fire("SessionEnd", { reason: "logout" });
  setInterval(() => {}, 1000);
}
`);
chmodSync(fakeClaude, 0o755);

// Herdr stub: `pane run` starts a real shell process in the pane. A tab can hold more than one pane.
const panes = new Map();
let counter = 0;
const herdrCalls = [];
let onCreate;
let onClose;
let onRun;
async function herdr(args) {
  herdrCalls.push(args);
  const [group, verb] = args;
  if (group === "tab" && verb === "create") {
    if (onCreate) return onCreate();
    counter += 1;
    const pane = { pane_id: `w1:p${counter}`, workspace_id: "w1", tab_id: `w1:t${counter}`, terminal_id: `term-${counter}` };
    panes.set(pane.pane_id, { ...pane, cwd: args[args.indexOf("--cwd") + 1], output: "" });
    return { result: { tab: { tab_id: pane.tab_id }, root_pane: pane } };
  }
  if (group === "pane" && verb === "run") {
    const pane = panes.get(args[2]);
    pane.child = spawn("sh", ["-c", args[3]], { cwd: pane.cwd, env: { ...process.env, ANTHROPIC_API_KEY: "leaked", CLAUDE_CODE_USE_BEDROCK: "1" } });
    pane.child.stdout.on("data", (chunk) => { pane.output += chunk; });
    pane.child.stderr.on("data", (chunk) => { pane.output += chunk; });
    onRun?.();
    return undefined;
  }
  if (group === "pane" && verb === "list") {
    return { result: { panes: [...panes.values()].map(({ output, child, cwd: _, ...shape }) => shape) } };
  }
  if (group === "pane" && verb === "get") {
    const pane = panes.get(args[2]);
    if (!pane) throw new Error('{"error":{"code":"pane_not_found"}}');
    const { output, child, cwd: _, ...shape } = pane;
    return { result: { pane: shape } };
  }
  if (group === "pane" && verb === "close") {
    const pane = panes.get(args[2]);
    pane?.child?.kill("SIGKILL");
    panes.delete(args[2]);
    // Runs after the pane is gone and before the close returns, like a real close still being confirmed.
    await onClose?.(args[2], pane);
    return undefined;
  }
  throw new Error(`unexpected herdr ${args.join(" ")}`);
}
const audits = [];
let detached = false;
const host = { stateDir, workerId: "lead", workspaceId: "w1", claudeCommand: fakeClaude, herdr,
  admit() { if (detached) throw new Error("Worker unavailable"); },
  readPane: async (id) => panes.get(id)?.output ?? "", audit: (event, data) => audits.push({ event, data }) };
const spec = (task, extra = {}) => ({ role: "review", cwd, task, model: "claude-opus-5-5", effort: "high", ...extra });
const paneOf = (id) => readClaudeWorker(stateDir, id).paneId;

try {
  // Completion: acceptance from UserPromptSubmit, settlement from Stop, credentials and provider routing unset, isolated leaf session.
  const done = await spawnClaude(host, spec("Review this. SCENARIO:complete"));
  assert.equal(done.kind, "accepted");
  assert.equal(done.evidence, "user_prompt_submit");
  const settled = await waitClaude(host, done.workerId, done.submissionId, 10000);
  assert.equal(settled.kind, "settled");
  assert.equal(settled.outcome, "completed");
  assert.match(settled.finalText, /^done model=claude-opus-5-5 effort=high apiKey=unset bedrock=unset /, "credentials and provider routing are unset");
  assert.equal(readFileSync(settled.artifactPath, "utf8"), settled.finalText);
  assert.equal(settled.transcriptPath, "/tmp/t.jsonl");
  assert.ok(Buffer.byteLength(herdrCalls.find((args) => args[1] === "run")[3]) < 1024, "Herdr types only a short exec line");
  await assert.rejects(waitClaude(host, done.workerId, "other-submission", 1000), /Unknown submission/);

  // A brief that looks like an option stays the prompt.
  const dashed = await spawnClaude(host, spec("--settings=/tmp/evil.json --help SCENARIO:complete"));
  assert.equal((await waitClaude(host, dashed.workerId, dashed.submissionId, 10000)).outcome, "completed");

  // Oversized briefs arrive by file pointer and still complete.
  const large = await spawnClaude(host, spec("x".repeat(130000) + " SCENARIO:complete"));
  const largeResult = await waitClaude(host, large.workerId, large.submissionId, 10000);
  assert.match(largeResult.finalText, /bytes=130018$/, "the worker read the whole brief from the file");

  // The first terminal event of the accepted session wins; later turns and other sessions do not replace it.
  const twice = await spawnClaude(host, spec("SCENARIO:twice"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await waitClaude(host, twice.workerId, twice.submissionId, 10000)).finalText, "first turn");
  assert.equal(readdirSync(join(stateDir, "claude", twice.workerId, "hooks")).filter((name) => name.startsWith("Stop-")).length, 2,
    "each hook invocation keeps its own file");
  const other = await spawnClaude(host, spec("SCENARIO:othersession"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await waitClaude(host, other.workerId, other.submissionId, 10000)).finalText, "own session");

  // Provider failure and session end without a result are distinct outcomes.
  const failed = await spawnClaude(host, spec("SCENARIO:fail"));
  const failure = await waitClaude(host, failed.workerId, failed.submissionId, 10000);
  assert.equal(failure.outcome, "error");
  assert.equal(failure.reason, "rate_limit");
  const ended = await spawnClaude(host, spec("SCENARIO:end"));
  const end = await waitClaude(host, ended.workerId, ended.submissionId, 10000);
  assert.equal(end.kind, "unavailable");
  assert.match(end.reason, /ended without a result \(logout\)/);

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
  const overlapResult = await waitClaude(host, overlap.workerId, overlap.submissionId, 10000);
  assert.ok(["overlap a", "overlap b"].includes(overlapResult.finalText));
  const overlapHooks = readdirSync(join(stateDir, "claude", overlap.workerId, "hooks"));
  assert.equal(overlapHooks.filter((name) => name.startsWith("Stop-")).length, 2);
  assert.ok(!overlapHooks.some((name) => name.endsWith(".tmp")));

  // Concurrent observers agree and settle once.
  const shared = await spawnClaude(host, spec("SCENARIO:complete"));
  const [first, second] = await Promise.all([waitClaude(host, shared.workerId, shared.submissionId, 10000), waitClaude(host, shared.workerId, shared.submissionId, 10000)]);
  assert.deepEqual(first, second);
  assert.equal(audits.filter((entry) => entry.event === "claude_settlement" && entry.data.claudeWorkerId === shared.workerId).length, 1);

  // Oversized error text is capped and still returns.
  const huge = await spawnClaude(host, spec("SCENARIO:hugefail"));
  const hugeResult = await waitClaude(host, huge.workerId, huge.submissionId, 10000);
  assert.equal(hugeResult.outcome, "error");
  assert.equal(hugeResult.reason.length, 4000);

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
    { kind: "timeout", runtime: "claude", workerId: hung.workerId, submissionId: hung.submissionId, active: true });
  await assert.rejects(retireClaude(host, hung.workerId), /active task/);
  assert.ok(unresolvedClaudeChild(stateDir, (parentId) => parentId === "lead"), "open or active Claude children block parent retirement");
  assert.equal(unresolvedClaudeChild(stateDir, (parentId) => parentId === "someone-else"), undefined);

  // Interrupt closes only its own pane in a split tab; the other pane survives.
  const hungPane = readClaudeWorker(stateDir, hung.workerId);
  panes.set("w1:split", { pane_id: "w1:split", workspace_id: "w1", tab_id: hungPane.tabId, terminal_id: "term-split", output: "" });
  const interrupted = await interruptClaude(host, hung.workerId, hung.submissionId);
  assert.equal(interrupted.outcome, "interrupted");
  assert.ok(!panes.has(hungPane.paneId) && panes.has("w1:split"), "only the exact Claude pane closed");
  assert.equal(readClaudeWorker(stateDir, hung.workerId).state, "closed");

  // Evidence that lands during the interrupt's close wins over the interruption.
  const racing = await spawnClaude(host, spec("SCENARIO:hang"));
  onClose = (paneId) => {
    if (paneId !== paneOf(racing.workerId)) return;
    writeFileSync(join(stateDir, "claude", racing.workerId, "hooks", "Stop-1-1.json"), JSON.stringify({ session_id: "s1", last_assistant_message: "finished first" }));
  };
  const raced = await interruptClaude(host, racing.workerId, racing.submissionId);
  onClose = undefined;
  assert.equal(raced.outcome, "completed");
  assert.equal(raced.finalText, "finished first");

  // A wait that observes the pane mid-interrupt does not record the close as a lost pane.
  const contested = await spawnClaude(host, spec("SCENARIO:hang"));
  let observed;
  onClose = async (paneId) => {
    if (paneId === paneOf(contested.workerId)) observed = await waitClaude(host, contested.workerId, contested.submissionId, 3000);
  };
  const contestedResult = await interruptClaude(host, contested.workerId, contested.submissionId);
  onClose = undefined;
  assert.equal(observed.outcome, "interrupted", "an observer that sees the pane gone mid-interrupt records the interruption");
  assert.equal(contestedResult.outcome, "interrupted");

  // An interrupter that dies after closing the pane leaves an interruption, not a task that stays active.
  const orphaned = await spawnClaude(host, spec("SCENARIO:hang"));
  const orphanedPath = join(stateDir, "claude", orphaned.workerId, "worker.json");
  writeFileSync(orphanedPath, JSON.stringify({ ...JSON.parse(readFileSync(orphanedPath, "utf8")), interrupting: true }));
  panes.get(paneOf(orphaned.workerId)).child.kill("SIGKILL");
  panes.delete(paneOf(orphaned.workerId));
  assert.equal((await waitClaude(host, orphaned.workerId, orphaned.submissionId, 3000)).outcome, "interrupted");

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
  panes.get(paneOf(lost.workerId)).child.kill("SIGKILL");
  panes.delete(paneOf(lost.workerId));
  const lostResult = await waitClaude(host, lost.workerId, lost.submissionId, 5000);
  assert.equal(lostResult.kind, "unavailable");
  assert.match(lostResult.reason, /closed without a result/);

  // Retirement closes the exact pane, keeps results, accepts an already-absent pane, and refuses a changed pane.
  const retired = await retireClaude(host, done.workerId);
  assert.equal(retired.state, "retired");
  assert.equal(readClaudeWorker(stateDir, done.workerId).task.finalText, settled.finalText);
  const gone = await spawnClaude(host, spec("SCENARIO:complete"));
  await waitClaude(host, gone.workerId, gone.submissionId, 10000);
  panes.get(paneOf(gone.workerId)).child.kill("SIGKILL");
  panes.delete(paneOf(gone.workerId));
  assert.equal((await retireClaude(host, gone.workerId)).state, "retired", "an absent pane counts as closed");
  const moved = await spawnClaude(host, spec("SCENARIO:complete"));
  await waitClaude(host, moved.workerId, moved.submissionId, 10000);
  panes.get(paneOf(moved.workerId)).terminal_id = "someone-else";
  await assert.rejects(retireClaude(host, moved.workerId), /identity changed; close refused/);
  assert.equal(readClaudeWorker(stateDir, moved.workerId).state, "open");
  panes.get(paneOf(moved.workerId)).terminal_id = readClaudeWorker(stateDir, moved.workerId).terminalId;
  // A pane moved to a new ID still holds the terminal: neither absent nor closable.
  const movedPane = panes.get(paneOf(moved.workerId));
  panes.delete(movedPane.pane_id);
  panes.set("w2:p99", { ...movedPane, pane_id: "w2:p99", workspace_id: "w2" });
  await assert.rejects(retireClaude(host, moved.workerId), /moved or identity changed; close refused/);
  panes.delete("w2:p99");
  panes.set(movedPane.pane_id, movedPane);

  // Listing reports owned workers without final text; retiring the rest clears the parent-retirement block.
  const rows = await listClaude(host, (parentId) => parentId === "lead");
  assert.ok(rows.length >= 10 && rows.every((row) => row.kind === "claude_status" && row.task.finalText === ""));
  assert.deepEqual(await listClaude(host, (parentId) => parentId === "someone-else"), []);
  for (const row of rows) if (row.state === "open" && row.task.kind !== "active") await retireClaude(host, row.workerId);
  for (const row of rows) if (row.task.kind === "active") await interruptClaude(host, row.workerId, row.task.submissionId);
  assert.equal(unresolvedClaudeChild(stateDir, (parentId) => parentId === "lead"), uncertainId, "only the uncertain launch still blocks");

  // Effort outside Claude's levels is refused; the executable resolves from PATH or an absolute override.
  await assert.rejects(spawnClaude(host, spec("SCENARIO:complete", { effort: "minimal" })), /Invalid|Expected|must/i);
  assert.equal(claudeCommand({ PATH: `/nonexistent:${join(root, "bin")}` }), fakeClaude);
  assert.equal(claudeCommand({ PATH: "", PI_HERDR_CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  assert.throws(() => claudeCommand({ PATH: "/nonexistent" }), /not found on PATH/);
  assert.throws(() => claudeCommand({ PI_HERDR_CLAUDE_BIN: "claude" }), /must be absolute/);
  assert.ok(audits.some((entry) => entry.event === "claude_launch") && audits.some((entry) => entry.event === "claude_settlement"));
  console.log("PASS Claude runtime module: interrupt versus observer mid-close, abandoned interrupts, detachment during launch, overlapping hooks, concurrent observers, capped errors, detached-runtime refusal, uncertain creation blocking, moved panes, hook acceptance and first-terminal settlement, session correlation, option-safe and file-pointer briefs, isolated leaf flags, unset API keys, error and session-end outcomes, trust refusal, cancelled and lost tab creation, launch-line limit, exact-pane interrupt and retirement in split tabs, interrupt race, lost panes, parent-retirement blocking, listing, effort validation, executable resolution. Herdr stubbed; fake claude; no model calls.");
} finally {
  for (const pane of panes.values()) pane.child?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
