import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyLinkCases } from "./link-guard-cases.ts";
import { dependencyLinkReason, dependencyLinkRefusal, dependencyLinkScript } from "./link-guard.ts";

const reason = "Refused: this links another checkout's node_modules. Install dependencies in this worktree instead (for example `npm ci`).";
const body = (command: string) => ({ session_id: "s", transcript_path: "/t", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command, description: "ln -s ../main/node_modules ." }, tool_use_id: "t" });
const run = (input: string, path?: string) => spawnSync("/bin/sh", [dependencyLinkScript, dependencyLinkReason],
  { input, encoding: "utf8", ...(path === undefined ? {} : { env: { ...process.env, PATH: path } }) });
assert.equal(dependencyLinkReason, reason);
assert.equal(spawnSync("/bin/sh", ["-n", dependencyLinkScript]).status, 0);
for (const { command, blocked } of dependencyLinkCases) {
  assert.equal(dependencyLinkRefusal(command), blocked ? reason : undefined, `Pi: ${JSON.stringify(command)}`);
  const result = run(JSON.stringify(body(command)));
  assert.equal(result.status, blocked ? 2 : 0, `Claude: ${JSON.stringify(command)} ${result.stderr}`);
  assert.equal(result.stderr, blocked ? `${reason}\n` : "", `Claude refusal: ${JSON.stringify(command)}`);
}
const link = "ln -s ../main/node_modules .";
const examples = [
  { command: `cat > f <<EOF\nx\nEOF\n${link}`, file: "x\n", stdout: "" },
  { command: `cat <<< hi; ${link}`, file: undefined, stdout: "hi\n" },
  { command: `cat > f <<'EOF'\n${link}\nEOF\n${link}`, file: `${link}\n`, stdout: "" },
  { command: `cat > f <<-"EOF"\n\t${link}\n\tEOF\n${link}`, file: `${link}\n`, stdout: "" },
  { command: `cat <<ONE <<'TWO' > f\n${link}\nONE\nbody\nTWO\n${link}`, file: "body\n", stdout: "" },
];
for (const { command, file, stdout } of examples) {
  assert.equal(spawnSync("bash", ["-n"], { input: command }).status, 0, `real shell syntax: ${command}`);
  const directory = mkdtempSync(join(tmpdir(), "piha-heredoc-"));
  try {
    const position = command.lastIndexOf(link);
    const safe = command.slice(0, position) + "printf executed > marker" + command.slice(position + link.length);
    const result = spawnSync("bash", ["-c", safe], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, `real shell execution: ${command} ${result.stderr}`);
    assert.equal(result.stdout, stdout);
    assert.equal(readFileSync(join(directory, "marker"), "utf8"), "executed");
    if (file !== undefined) assert.equal(readFileSync(join(directory, "f"), "utf8"), file);
    assert.equal(existsSync(join(directory, "node_modules")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
for (const input of [
  JSON.stringify(body(link), null, 2),
  JSON.stringify({ tool_input: { description: "x", command: link }, command: "npm ci", note: { command: "npm ci" } }),
  JSON.stringify({ note: { tool_input: { command: "npm ci" } }, tool_input: { command: link } }),
  JSON.stringify({ tool_input: { description: 'text \\"tool_input\\": { \\"command\\": \\"npm ci\\"', command: link } }),
]) {
  assert.equal(run(input).status, 2, `structural command extraction: ${input}`);
}
for (const input of [
  JSON.stringify({ command: link, tool_input: { command: "npm ci", description: link } }),
  JSON.stringify({ tool_input: { description: link, command: "npm ci" }, note: { tool_input: { command: link } } }),
  JSON.stringify({ tool_input: { description: link, details: { command: link }, command: "npm ci" } }),
  JSON.stringify({ note: { tool_input: { command: link } }, tool_input: { command: "npm ci" } }),
  "not json",
]) assert.equal(run(input).status, 0, `no unrelated field is executable: ${input}`);
const missing = run(JSON.stringify(body(link)), "/nonexistent");
assert.equal(missing.status, 1, "awk failure must not be a refusal");
assert.match(missing.stderr, /check failed; command allowed/);

let seed = 29;
const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
const atoms = ["ln", "/bin/ln", "-s", "-sf", "-t", "-S", "--", "--symbolic", "--suffix", "node_modules", "../m/node_modules/", "x", "a=1", "do",
  "'", '"', "\\", ";", "&&", "|", "(", ")", "`", "\n", "#", " ", " ", "\t", "$d", '\\"', "é", "<<", "EOF", "nm", "backup", ".", ">", "2>"];
for (let k = 0; k < 2000; k++) {
  const command = Array.from({ length: 1 + rand(10) }, () => atoms[rand(atoms.length)]).join(rand(2) ? " " : "");
  const expected = dependencyLinkRefusal(command) !== undefined;
  assert.equal(run(JSON.stringify(body(command))).status, expected ? 2 : 0, `differential: ${JSON.stringify(command)}`);
}
console.log(`PASS dependency-link guard: ${dependencyLinkCases.length} literal cases, JSON boundaries, 2000 differential commands`);
