import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment } from "./fakes.ts";

const inherited = { PATH: "/fixture/bin", DS_HERDR_SOCKET_DIR: "/unrelated", DS_HERDR_FUTURE_KEY: "unrelated" };
const overrides = { DS_HERDR_LAUNCH_ID: "fixture-claim", DS_HERDR_RESTART_GENERATION: "fixture-generation" };
assert.deepEqual(fixtureEnvironment(overrides, inherited), { PATH: "/fixture/bin", ...overrides });
assert.equal(inherited.DS_HERDR_SOCKET_DIR, "/unrelated");

const root = mkdtempSync(join(tmpdir(), "piha-isolation-"));
const socketDir = join(root, "sockets");
const stateDir = join(root, "state");
mkdirSync(socketDir);
mkdirSync(stateDir);
writeFileSync(join(socketDir, "sentinel"), "socket sentinel");
writeFileSync(join(stateDir, "sentinel"), "state sentinel");
const changes: string[] = [];
const watchers = [socketDir, stateDir].map(path => watch(path, (_event, file) => changes.push(`${path}/${file}`)));
try {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DS_HERDR_")));
  Object.assign(env, {
    DS_HERDR_STATE_DIR: stateDir, DS_HERDR_SOCKET_DIR: socketDir, DS_HERDR_WORKER_ID: "sentinel", DS_HERDR_ROLE: "review",
    DS_HERDR_PARENT_ID: "sentinel", DS_HERDR_SESSION: "sentinel", DS_HERDR_WORKSPACE: root,
    DS_HERDR_WORKSPACE_ID: "sentinel", DS_HERDR_LAUNCH_ID: "sentinel", DS_HERDR_RESTART_GENERATION: "sentinel",
    DS_HERDR_FUTURE_KEY: "sentinel",
  });
  const child = spawn(process.execPath, ["launch-race-check.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.equal(changes.length, 0, `inherited sentinel directory changed: ${changes.join(", ")}`);
  assert.deepEqual(readdirSync(socketDir), ["sentinel"]);
  assert.deepEqual(readdirSync(stateDir), ["sentinel"]);
  assert.equal(readFileSync(join(socketDir, "sentinel"), "utf8"), "socket sentinel");
  assert.equal(readFileSync(join(stateDir, "sentinel"), "utf8"), "state sentinel");
  process.stdout.write("PASS launch-race ignores inherited adapter state and socket sentinels.\n");
} finally {
  for (const watcher of watchers) watcher.close();
  rmSync(root, { recursive: true, force: true });
}
