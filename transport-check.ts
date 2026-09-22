import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, RequestSchema, request, socketAlive } from "./protocol.ts";

const base = { callerId: "lead", callerGeneration: "g1", generation: "g2" };
assert.throws(() => parse(RequestSchema, { ...base, kind: "wait", submissionId: "s1", timeoutMs: 0 }));
assert.throws(() => parse(RequestSchema, { ...base, kind: "submit", submissionId: "../escape", task: "x" }));
assert.throws(() => parse(RequestSchema, { ...base, generation: undefined, kind: "status" }));
assert.equal(parse(RequestSchema, { ...base, kind: "wait", submissionId: "s1", timeoutMs: 1 }).kind, "wait");

// Short UDS path is necessary; all check files remain beneath prototype/.
const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".transport-"));
const originalCwd = process.cwd();
process.chdir(directory);
const socketPath = "check.sock";
let requests = 0;
const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const message = parse(RequestSchema, JSON.parse(buffer.slice(0, newline)));
    requests++;
    if (message.kind === "submit") {
      socket.end(JSON.stringify({ ok: true, result: { kind: "accepted", workerId: "child", generation: "g2", submissionId: message.submissionId, evidence: "agent_start" } }) + "\n");
    } else if (message.kind === "wait") {
      const timer = setTimeout(() => socket.end(JSON.stringify({ ok: true, result: { kind: "timeout", workerId: "child", generation: "g2", submissionId: message.submissionId, active: true } }) + "\n"), message.timeoutMs);
      socket.once("close", () => clearTimeout(timer));
    } else {
      socket.end(JSON.stringify({ ok: false, error: "deliberate transport rejection" }) + "\n");
    }
  });
});
try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  assert.equal(await socketAlive(socketPath), true);
  const accepted = await request(socketPath, { ...base, kind: "submit", submissionId: "s1", task: "x" });
  assert.equal(accepted.kind, "accepted");
  const start = Date.now();
  const timed = await request(socketPath, { ...base, kind: "wait", submissionId: "s1", timeoutMs: 30 });
  assert.equal(timed.kind, "timeout");
  assert.ok(Date.now() - start >= 25);
  await assert.rejects(request(socketPath, { ...base, kind: "status" }), /deliberate transport rejection/);
  const controller = new AbortController();
  const pending = request(socketPath, { ...base, kind: "wait", submissionId: "s1", timeoutMs: 1000 }, controller.signal);
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, /Caller cancelled/);
  assert.equal(requests, 4);
  process.stdout.write("PASS schema validation, real UDS request/response, deadline response, rejection, abort cleanup. Not Pi lifecycle evidence.\n");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.chdir(originalCwd);
  rmSync(directory, { recursive: true, force: true });
}
