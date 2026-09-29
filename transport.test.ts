import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse, RequestSchema, request, socketAlive } from "./protocol.ts";

const base = { callerId: "lead", callerGeneration: "g1", generation: "g2" };
test("rejects wait deadlines below one millisecond", () => {
  assert.throws(() => parse(RequestSchema, { ...base, kind: "wait", submissionId: "s1", timeoutMs: 0 }));
});
test("rejects unsafe submission IDs", () => {
  assert.throws(() => parse(RequestSchema, { ...base, kind: "submit", submissionId: "../escape", task: "x" }));
});
test("requires a target generation", () => {
  assert.throws(() => parse(RequestSchema, { ...base, generation: undefined, kind: "status" }));
});
test("accepts the minimum wait deadline", () => {
  assert.equal(parse(RequestSchema, { ...base, kind: "wait", submissionId: "s1", timeoutMs: 1 }).kind, "wait");
});

test("exchanges four correlated requests and excludes liveness from the count", async () => {
const directory = mkdtempSync("/tmp/pha-");
const socketPath = join(directory, "check.sock");
const sockets = new Set<Socket>();
let abortTimer: ReturnType<typeof setTimeout> | undefined;
let requests = 0;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
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
  abortTimer = setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, /Caller cancelled/);
  assert.equal(requests, 4);

} finally {
  clearTimeout(abortTimer);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
});
