import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { onTestFinished, test } from "vitest";
import { fileURLToPath } from "node:url";
import { ownChild } from "./test-support/process.ts";
import { finishCleanup } from "./test-support/cleanup.ts";
import { ownTestCleanup } from "./test-support/ownership.ts";
import { watch, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment } from "./fakes.ts";

test("scrubs inherited adapter keys without mutating input", () => {
  const inherited = { PATH: "/fixture/bin", DS_HERDR_SOCKET_DIR: "/unrelated", DS_HERDR_FUTURE_KEY: "unrelated", HERDR_SESSION_NAME: "named" };
  const overrides = { DS_HERDR_LAUNCH_ID: "fixture-claim", DS_HERDR_RESTART_GENERATION: "fixture-generation", HERDR_SESSION: "", HERDR_SESSION_NAME: undefined };
  assert.deepEqual(fixtureEnvironment(overrides, inherited), { PATH: "/fixture/bin", DS_HERDR_LAUNCH_ID: "fixture-claim", DS_HERDR_RESTART_GENERATION: "fixture-generation", HERDR_SESSION: "" });
  assert.equal(inherited.DS_HERDR_SOCKET_DIR, "/unrelated");
});

test("cleanup retains the body failure and attempts every closer", async () => {
  const body = new Error("body failure"), first = new Error("first cleanup failure"), last = new Error("last cleanup failure");
  const closed: string[] = [];
  await assert.rejects(finishCleanup([body], [
    () => { closed.push("first"); throw first; },
    async () => { closed.push("middle"); },
    () => { closed.push("last"); throw last; },
  ]), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [body, first, last]);
    return true;
  });
  assert.deepEqual(closed, ["first", "middle", "last"]);
});

test("runner lifecycle owns cleanup independently of body finally", () => {
  let closed = 0;
  onTestFinished(() => { assert.equal(closed, 1); });
  ownTestCleanup(() => [() => { closed++; }], []);
});

test("overlapping cleanup calls share one operation", async () => {
  let closed = 0;
  const cleanup = ownTestCleanup(() => [async () => {
    closed++;
    await new Promise(resolve => setTimeout(resolve, 20));
  }], []);
  await Promise.all([cleanup.finish([]), cleanup.finish([])]);
  assert.equal(closed, 1);
});

const checks = ["launch-race-check.ts", "adapter-check.ts", "selection-check.ts", "retirement-check.ts"] as const;
for (const file of checks) {
  const check = file.replace(/\.ts$/, "");
  test(`${check} ignores inherited adapter state and socket paths`, { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "piha-isolation-"));
    const socketDir = join(root, "sockets");
    const stateDir = join(root, "state");
    const changes: string[] = [];
    const errors: unknown[] = [];
    const cleanup: (() => unknown)[] = [() => rmSync(root, { recursive: true, force: true })];
    const ownedCleanup = ownTestCleanup(() => cleanup, [() => rmSync(root, { recursive: true, force: true })]);
    try {
      mkdirSync(socketDir, { mode: 0o700 });
      mkdirSync(stateDir, { mode: 0o700 });
      writeFileSync(join(socketDir, "sentinel"), "socket sentinel");
      writeFileSync(join(stateDir, "sentinel"), "state sentinel");
      for (const path of [socketDir, stateDir]) {
        const watcher = watch(path, (_event, file) => changes.push(`${path}/${file}`));
        cleanup.unshift(() => watcher.close());
      }
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DS_HERDR_")));
      Object.assign(env, {
        DS_HERDR_STATE_DIR: stateDir, DS_HERDR_SOCKET_DIR: socketDir, DS_HERDR_WORKER_ID: "sentinel", DS_HERDR_ROLE: "review",
        DS_HERDR_PARENT_ID: "sentinel", DS_HERDR_SESSION: "sentinel", DS_HERDR_WORKSPACE: root,
        DS_HERDR_WORKSPACE_ID: "sentinel", DS_HERDR_LAUNCH_ID: "sentinel", DS_HERDR_RESTART_GENERATION: "sentinel",
        DS_HERDR_FUTURE_KEY: "sentinel", HERDR_SESSION_NAME: "named",
      });
      const child = spawn("npm", ["run", check], { cwd: fileURLToPath(new URL(".", import.meta.url)), env, detached: true, stdio: ["ignore", "inherit", "pipe"] });
      const owned = ownChild(child, true);
      cleanup.unshift(() => owned.stop());
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      const { code, signal } = await owned.wait(165_000);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(signal, null, `${file}: ${stderr}`);
      assert.equal(code, 0, `${file}: ${stderr}`);
      assert.equal(changes.length, 0, `${file} changed an inherited sentinel directory: ${changes.join(", ")}`);
      assert.deepEqual(readdirSync(socketDir), ["sentinel"], file);
      assert.deepEqual(readdirSync(stateDir), ["sentinel"], file);
      assert.equal(readFileSync(join(socketDir, "sentinel"), "utf8"), "socket sentinel", file);
      assert.equal(readFileSync(join(stateDir, "sentinel"), "utf8"), "state sentinel", file);
    } catch (error) {
      errors.push(error);
    } finally {
      await ownedCleanup.finish(errors);
    }
  });
}
