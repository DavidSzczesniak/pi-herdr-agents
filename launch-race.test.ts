import assert from "node:assert/strict";
import { test } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./protocol.ts";
import { runtimeSocket, socketDirectory } from "./startup.ts";
import { present, fixtureEnvironment } from "./fakes.ts";
import { ownChild } from "./test-support/process.ts";
import type { RaceMessage } from "./test-support/launch-contender.ts";

const file = fileURLToPath(import.meta.url);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sessionHeader = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dirname(file) }) + "\n";

function raceMessage(message: unknown): RaceMessage {
  if (typeof message !== "object" || message === null || !("worker" in message) || typeof message.worker !== "string" || !("kind" in message)) throw new Error("invalid contender message");
  if (message.kind === "ready") return { kind: "ready", worker: message.worker };
  if (message.kind === "opened" && "model" in message && typeof message.model === "string" && "thinking" in message && typeof message.thinking === "string") return { kind: "opened", worker: message.worker, model: message.model, thinking: message.thinking };
  if (message.kind === "result" && "error" in message && typeof message.error === "string") return { kind: "result", worker: message.worker, error: message.error };
  throw new Error("invalid contender message");
}

async function withRace(check: (race: { state: string; originalSession: string; messages: RaceMessage[] }) => void) {
  const directory = mkdtempSync("/tmp/pha-");
  const state = directory;
  const children: ChildProcess[] = [];
  const owned: ReturnType<typeof ownChild>[] = [];
  const messages: RaceMessage[] = [];
  const messageErrors: unknown[] = [];
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (messageErrors.length) throw new AggregateError(messageErrors, "contender IPC failed");
      if (Date.now() > deadline) throw new Error(`Race check deadline: ${JSON.stringify(messages)}`);
      await sleep(10);
    }
  }
  function start(worker: string) {
    const child = fork(fileURLToPath(new URL("./test-support/launch-contender.ts", import.meta.url)), [], { execArgv: [], env: fixtureEnvironment({ RACE_STATE: state, RACE_WORKER: worker, RACE_PACKAGE_DIR: dirname(file), XDG_RUNTIME_DIR: directory }), stdio: ["ignore", "inherit", "inherit", "ipc"] });
    owned.push(ownChild(child));
    children.push(child);
    child.on("message", message => {
      try { messages.push(raceMessage(message)); } catch (error) { messageErrors.push(error); }
    });
    return child;
  }
  try {
    const lead = start("lead");
    await waitFor(() => messages.some(message => message.kind === "ready" && message.worker === "lead"));
    const owner = start("owner");
    await waitFor(() => messages.some(message => message.kind === "ready" && message.worker === "owner"));
    const originalSession = join(state, "sessions", "dead.jsonl");
    const initial = sessionHeader("original-pi-uuid");
    writeFileSync(originalSession, initial);
    mkdirSync(join(state, "tasks", "dead"));
    const parent = JSON.parse(readFileSync(join(state, "workers", "owner.json"), "utf8"));
    atomicWrite(join(state, "workers", "dead.json"), { ...parent, workerId: "dead", parentId: "owner", generation: "old-generation",
      pidBirth: "proven-nonmatching-birth", piSessionId: "original-pi-uuid", piSessionPath: originalSession,
      socketPath: runtimeSocket(state, "old-generation", directory), model: { provider: "original-provider", id: "assigned-model" }, thinking: "low" });
    lead.send("go");
    owner.send("go");
    await waitFor(() => messages.some(message => message.kind === "opened") && messages.some(message => message.kind === "result"));
    for (const child of children) if (child.connected) child.send("release");
    await waitFor(() => messages.filter(message => message.kind === "result").length === 2);
    await Promise.all(owned.map(child => child.wait(10_000)));
    for (const child of children) {
      assert.equal(child.exitCode, 0, "contender completed lifecycle cleanup");
    }
    check({ state, originalSession, messages });
  } finally {
    const results = await Promise.allSettled(owned.map(child => child.stop()));
    rmSync(socketDirectory(state, directory), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "contender cleanup failed");
  }
}

test("only one authorized ancestor crosses the native session-open boundary", { timeout: 30_000 }, () => withRace(({ messages }) => {
  const opened = messages.filter(message => message.kind === "opened");
  assert.equal(opened.length, 1, "only one authorized ancestor crosses native session-open boundary");
  const losingResult = present(messages.find(message => message.kind === "result"), "losing result");
  assert.match(losingResult.error, /EEXIST/);
}));

test("cold race retains saved model, thinking, and original UUID", { timeout: 30_000 }, () => withRace(({ state, originalSession, messages }) => {
  const opened = messages.filter(message => message.kind === "opened");
  assert.equal(opened[0]?.model, "original-provider/assigned-model", "no-message revival explicitly uses original model, not caller/default");
  assert.equal(opened[0]?.thinking, "low", "cold continuation keeps saved effort, not role default");
  const claim = JSON.parse(readFileSync(join(state, "locks", "launch-dead", "claim.json"), "utf8"));
  assert.deepEqual(claim.model, { provider: "original-provider", id: "assigned-model" });
  assert.equal(claim.thinking, "low");
  const entries = readFileSync(originalSession, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[0].id, "original-pi-uuid");
}));

test("losing contender cannot append native metadata", { timeout: 30_000 }, () => withRace(({ originalSession }) => {
  const entries = readFileSync(originalSession, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.length, 2, "losing attempt never appends pre-hook SDK metadata");
}));

test("uncertain startup cleanup retains the launch claim and both contenders shut down", { timeout: 30_000 }, () => withRace(({ state, messages }) => {
  assert.ok(messages.some(message => message.kind === "result" && /cleanup uncertain/.test(message.error)));
  assert.ok(existsSync(join(state, "locks", "launch-dead", "claim.json")), "uncertain startup/cleanup keeps per-worker fence");
}));
