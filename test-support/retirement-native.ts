import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import adapter from "../index.ts";
import { request } from "../protocol.ts";
import { isOriginalProcessLive } from "../runtime.ts";
import { fakeApi, fakeContext, fakeModel, fakeModelRegistry, fakeSessions, fakeUi, hookRegistry, toolRegistry, present, installFixtureEnvironment, herdrArgs, herdrResult, execOk, execFailure, beforeAgentStart } from "../fakes.ts";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { Request } from "../protocol.ts";

export type RetirementMode = "idle" | "busy" | "pending" | "queued" | "no-shutdown" | "noauth" | "resume";
type Actor = { kind: "lead" } | { kind: "child"; id: string; mode: RetirementMode; parent: string };
export function retirementNative(directory: string, actor: Actor) {
  const inChild = actor.kind === "child";
  const id = actor.kind === "child" ? actor.id : "lead";
  const mode = actor.kind === "child" ? actor.mode : "idle";
  const parent = actor.kind === "child" ? actor.parent : "";
  const identities = new Map<string, ReturnType<typeof identity>>();
  const closed = new Set<string>();
  const faults = new Map<string, string>();
  let startResumed: ((op: string[]) => Promise<void>) | undefined;
  let createdId: string | undefined;
  let cleanupAbort: AbortController | undefined;
  let abortPoint: string | undefined;
  const pane = (id: string) => ({ pane_id: `w:p-${id}`, workspace_id: "w", tab_id: `tab-${id}`, terminal_id: `term-${id}` });
  const identity = (id: string) => JSON.parse(readFileSync(join(directory, "workers", `${id}.json`), "utf8"));
  type OwnRequest = Request extends infer R ? R extends Request ? Omit<R, "callerId" | "callerGeneration" | "generation"> : never : never;
  const query = (who: { socketPath: string; generation: string }, operation: OwnRequest) => request(who.socketPath, { ...operation, callerId: "lead", callerGeneration: identity("lead").generation, generation: who.generation });
  const configEnv = { XDG_RUNTIME_DIR: directory, DS_HERDR_STATE_DIR: directory, DS_HERDR_SESSION: "fixture", DS_HERDR_WORKSPACE: directory,
    DS_HERDR_WORKER_ID: id, DS_HERDR_ROLE: inChild ? "implement" : "lead", DS_HERDR_PARENT_ID: parent,
    HERDR_ENV: "1", HERDR_SESSION: "fixture", HERDR_SOCKET_PATH: "/fixture/retirement.sock", HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: pane(process.env.RETIRE_NEW_PANE ? `${id}-new` : id).pane_id };
  if (inChild) {
    Object.assign(process.env, configEnv);
    delete process.env.DS_HERDR_WORKSPACE_ID;
    if (mode !== "resume") {
      delete process.env.DS_HERDR_LAUNCH_ID;
      delete process.env.DS_HERDR_RESTART_GENERATION;
    }
  } else {
    mkdirSync(join(directory, "sessions"), { mode: 0o700 });
    installFixtureEnvironment(configEnv);
  }
  function native() {
    const hooks = hookRegistry();
    const tools = toolRegistry();
    const file = join(directory, "sessions", `${id}.jsonl`);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: `pi-${id}`, cwd: directory }) + "\n");
    let active = false;
    let queued = mode === "queued";
    const ctx = fakeContext({ cwd: directory, mode: "tui", hasUI: true, signal: undefined,
      model: mode === "noauth" ? undefined : fakeModel("fixture", "model"),
      modelRegistry: fakeModelRegistry({ auth: true }),
      sessionManager: fakeSessions({ getSessionFile: () => file, getSessionId: () => `pi-${id}` }),
      isIdle: () => !active, hasPendingMessages: () => queued,
      shutdown: () => { if (inChild && mode !== "no-shutdown") void emit({ type: "session_shutdown", reason: "quit" }).then(() => process.exit(0)); },
      ui: fakeUi({ notify(message) { throw new Error(message); }, setWidget() {} }),
    });
    if (mode === "noauth") Reflect.set(ctx, "model", null);
    const emit = (event: ExtensionEvent) => hooks.emit(event, ctx);
    const api = fakeApi({ on: hooks.on, registerTool: tools.register,
      registerCommand() {}, getActiveTools: () => ["read", "bash"], setActiveTools() {}, getThinkingLevel: () => "medium",
      async exec(_command, args) {
        const op = herdrArgs(args);
        if (op[0] === "tab" && op[1] === "create") {
          createdId = present(present(op.find(value => value.startsWith("DS_HERDR_WORKER_ID=")), "worker environment").split("=")[1], "created worker id");
          return herdrResult({ root_pane: pane(`${createdId}-new`) });
        }
        if (op[0] === "agent" && op[1] === "start") {
          await startResumed?.(op);
          return execOk("{}");
        }
        if (op[0] === "pane" && op[1] === "get") return herdrResult({ pane: pane(present(op[2], "pane id").slice(4)) });
        if (op[0] === "pane" && op[1] === "list") {
          if (abortPoint === "after-close-list" && closed.has("abort-after-close")) present(cleanupAbort, "cleanup abort controller").abort();
          return herdrResult({ panes: [...identities.keys()].filter(key => !closed.has(key))
            .filter(key => faults.get(key) !== "absent" || isOriginalProcessLive(identity(key)))
            .map(key => faults.get(key) === "moved" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), tab_id: "other-tab" } :
              faults.get(key) === "terminal" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), terminal_id: "replacement" } :
                faults.get(key) === "workspace-move" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), workspace_id: "other-workspace" } :
                  faults.get(key) === "pane-id-move" && !isOriginalProcessLive(identity(key)) ? { ...pane(key), pane_id: "w:p-relocated" } : pane(key)) });
        }
        if (op[0] === "tab" && op[1] === "get") return herdrResult({ tab: { tab_id: present(op[2], "pane id"), workspace_id: "w", pane_count: 1 } });
        if (op[0] === "pane" && op[1] === "process-info") {
          const key = present(op[3], "pane id").slice(4);
          if (abortPoint === "process-info" && key === "cleanup-abort") present(cleanupAbort, "cleanup abort controller").abort();
          const fault = faults.get(key);
          const info = { pane_id: present(op[3], "pane id"), shell_pid: fault === "null-shell" ? null : 1,
            foreground_process_group_id: fault === "null-group" ? null : fault === "foreign-group" || fault === "empty-foreground" ? 2 : 1,
            foreground_processes: fault === "empty-foreground" ? [] : [{ pid: fault === "occupant" || fault === "foreign-process" ? 2 : 1, name: "process" }] };
          const rawInfo: Record<string, unknown> = { ...info };
          if (fault === "missing-group") delete rawInfo.foreground_process_group_id;
          if (fault === "missing-foreground") delete rawInfo.foreground_processes;
          return herdrResult({ process_info: rawInfo });
        }
        if (op[0] === "pane" && op[1] === "close") {
          closed.add(present(op[2], "pane id").slice(4));
          if (abortPoint === "close" && present(op[2], "pane id") === "w:p-abort-after-close") present(cleanupAbort, "cleanup abort controller").abort();
          if (present(op[2], "pane id") === "w:p-close-error") return execFailure("fixture close response lost");
          return execOk();
        }
        return execOk();
      },
      sendUserMessage(text) { if (typeof text !== "string") throw new Error("expected user text"); active = true;
        if (mode === "resume") void (async () => {
          await emit({ type: "input", source: "extension", text });
          await emit(beforeAgentStart({ cwd: directory, prompt: text }));
          await emit({ type: "agent_start" });
        })();
      }, appendEntry() {},
    });
    adapter(api);
    return { tools, ctx, emit, setQueued(value: boolean) { queued = value; } };
  }
  return { identity, identities, closed, faults, query, native,
    controls: {
      get createdId() { return createdId; },
      set startResumed(value: typeof startResumed) { startResumed = value; },
      get cleanupAbort() { return cleanupAbort; },
      set cleanupAbort(value: AbortController | undefined) { cleanupAbort = value; },
      set abortPoint(value: string | undefined) { abortPoint = value; },
    },
  };
}
