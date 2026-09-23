import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, Role, SafeId } from "./protocol.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export function socketDirectory(stateDir: string, runtimeRoot = "/tmp"): string {
  return join(runtimeRoot, `piha-${process.getuid?.()}`, hash(stateDir).slice(0, 24));
}
export function runtimeSocket(stateDir: string, generation: string, runtimeRoot = "/tmp"): string {
  return join(socketDirectory(stateDir, runtimeRoot), `${parse(SafeId, generation)}.sock`);
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error(`Runtime directory must be private to current user: ${path}`);
}

export function startupConfig(ctx: ExtensionContext, env: NodeJS.ProcessEnv) {
  // RPC hasUI is true. Only native interactive sessions may own Herdr panes.
  if (ctx.mode !== "tui" || env.HERDR_ENV !== "1" || !ctx.sessionManager.getSessionFile()) return null;
  if (!env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) throw new Error("Missing native Herdr socket or pane identity");
  if (!isAbsolute(env.HERDR_SOCKET_PATH)) throw new Error("Herdr socket must be absolute");
  const herdrSocket = env.HERDR_SOCKET_PATH;
  // Herdr 0.9 names the server in HERDR_SESSION; 0.8 used HERDR_SESSION_NAME.
  const herdrSession = env.HERDR_SESSION || env.HERDR_SESSION_NAME || "";
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const explicit = Boolean(env.DS_HERDR_WORKER_ID);
  const workerId = explicit ? parse(SafeId, required("DS_HERDR_WORKER_ID")) : "lead";
  const role = explicit ? parse(Role, required("DS_HERDR_ROLE")) : "lead";
  const parentId = explicit && env.DS_HERDR_PARENT_ID ? parse(SafeId, env.DS_HERDR_PARENT_ID) : null;
  if (workerId === "lead" ? parentId !== null || role !== "lead" : parentId === null || role === "lead")
    throw new Error("Only lead may be root");
  if (explicit && env.DS_HERDR_SESSION !== herdrSession) throw new Error("Child Herdr session mismatch");
  const root = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (!isAbsolute(root)) throw new Error("XDG_STATE_HOME must be absolute");
  const stateDir = explicit ? required("DS_HERDR_STATE_DIR") : join(root, "pi-herdr-agents", "v1", hash(JSON.stringify([
    herdrSocket, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(),
  ])));
  const cwd = explicit ? required("DS_HERDR_WORKSPACE") : resolve(ctx.cwd);
  if (!isAbsolute(stateDir) || !isAbsolute(cwd)) throw new Error("Runtime paths must be absolute");
  const runtimeRoot = env.XDG_RUNTIME_DIR || "/tmp";
  if (!isAbsolute(runtimeRoot)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  const socketDir = env.DS_HERDR_SOCKET_DIR || socketDirectory(stateDir, runtimeRoot);
  if (!isAbsolute(socketDir) || Buffer.byteLength(join(socketDir, "00000000-0000-0000-0000-000000000000.sock")) > 103)
    throw new Error("Runtime socket path too long; use a short XDG_RUNTIME_DIR");
  return {
    automatic: !explicit, stateDir, socketDir, workerId, parentId, role, herdrSession, herdrSocket, cwd,
    paneId: env.HERDR_PANE_ID, workspaceId: env.DS_HERDR_WORKSPACE_ID || env.HERDR_WORKSPACE_ID || "",
    restartGeneration: env.DS_HERDR_RESTART_GENERATION || null, launchId: env.DS_HERDR_LAUNCH_ID || null,
    // Herdr's server environment need not match the calling Pi process.
    childEnvironment: Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_CACHE_RETENTION"]
      .flatMap(key => env[key] === undefined ? [] : [[key, env[key]]])),
  };
}
export type StartupConfig = NonNullable<ReturnType<typeof startupConfig>>;

export function herdrCommand(config: Pick<StartupConfig, "herdrSocket" | "herdrSession">, args: string[]): string[] {
  // Do not pass --session: it can select a different server than the pane's socket.
  return ["-u", "HERDR_SESSION", "-u", "HERDR_SESSION_NAME", `HERDR_SOCKET_PATH=${config.herdrSocket}`, "herdr", ...args];
}
