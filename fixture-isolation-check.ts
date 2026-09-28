import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnvironment } from "./fakes.ts";

const inherited = { PATH: "/fixture/bin", DS_HERDR_SOCKET_DIR: "/unrelated", DS_HERDR_FUTURE_KEY: "unrelated", HERDR_SESSION_NAME: "named" };
const overrides = { DS_HERDR_LAUNCH_ID: "fixture-claim", DS_HERDR_RESTART_GENERATION: "fixture-generation", HERDR_SESSION: "", HERDR_SESSION_NAME: undefined };
assert.deepEqual(fixtureEnvironment(overrides, inherited), { PATH: "/fixture/bin", DS_HERDR_LAUNCH_ID: "fixture-claim", DS_HERDR_RESTART_GENERATION: "fixture-generation", HERDR_SESSION: "" });
assert.equal(inherited.DS_HERDR_SOCKET_DIR, "/unrelated");

const root = mkdtempSync(join(tmpdir(), "piha-isolation-"));
const socketDir = join(root, "sockets");
const stateDir = join(root, "state");
mkdirSync(socketDir, { mode: 0o700 });
mkdirSync(stateDir, { mode: 0o700 });
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
    DS_HERDR_FUTURE_KEY: "sentinel", HERDR_SESSION_NAME: "named",
  });
  const checks = ["launch-race-check.ts", "adapter-check.ts", "selection-check.ts", "retirement-check.ts"] as const;
  for (const file of checks) {
    const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, `${file}: ${stderr}`);
    assert.equal(code, 0, `${file}: ${stderr}`);
    assert.equal(changes.length, 0, `${file} changed an inherited sentinel directory: ${changes.join(", ")}`);
    assert.deepEqual(readdirSync(socketDir), ["sentinel"], file);
    assert.deepEqual(readdirSync(stateDir), ["sentinel"], file);
    assert.equal(readFileSync(join(socketDir, "sentinel"), "utf8"), "socket sentinel", file);
    assert.equal(readFileSync(join(stateDir, "sentinel"), "utf8"), "state sentinel", file);
  }
  process.stdout.write("PASS adapter fixtures ignore inherited state, sockets, and legacy Herdr session.\n");
} finally {
  for (const watcher of watchers) watcher.close();
  rmSync(root, { recursive: true, force: true });
}
