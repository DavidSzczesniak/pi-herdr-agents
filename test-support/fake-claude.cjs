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
const pointer = /^Your complete task brief is in (\S+)\. /.exec(prompt);
if (pointer) prompt = readFileSync(pointer[1], "utf8");
const hooks = JSON.parse(readFileSync(options["--settings"], "utf8")).hooks;
// Like Claude Code, every session has a transcript, and each own-session Stop is followed by its summary line.
const transcript = /TRANSCRIPT:(\S+)/.exec(prompt)?.[1] ?? require("node:path").join(options["--add-dir"][0], "transcript.jsonl");
require("node:fs").appendFileSync(transcript, "");
const summary = () => require("node:fs").appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: "system",
  subtype: "stop_hook_summary", hookInfos: [{ command: hooks.Stop[0].hooks[0].command }] }) + "\n");
const fire = (event, input) => {
  const body = { hook_event_name: event, session_id: "s1", transcript_path: transcript, ...input };
  execSync(hooks[event][0].hooks[0].command, { input: JSON.stringify(body) });
  if (event === "Stop" && body.session_id === "s1") summary();
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const scenario = /SCENARIO:(\w+)/.exec(prompt)?.[1];
// Deferred-work scenarios write a real transcript in Claude Code's shape and gate each later turn on a file the test creates.
const { appendFileSync, existsSync } = require("node:fs");
const log = (entry) => appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
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
    log({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>bt1</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n</task-notification>" });
    log({ type: "user", message: { content: "<task-notification>\n<task-id>bt1</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n</task-notification>" } });
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
    const notice = "<task-notification>\n<task-id>bm7</task-id>\n<tool-use-id>tm7</tool-use-id>\n<status>completed</status>\n</task-notification>";
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
