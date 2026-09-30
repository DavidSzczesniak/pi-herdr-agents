import { type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { onProcessExit } from "./exit.ts";

export function ownChild(child: ChildProcess, processGroup = false) {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  function signal(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (processGroup) process.kill(-child.pid, signal);
      else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  const release = onProcessExit(() => signal("SIGTERM"));
  let stopping: Promise<void> | undefined;
  return {
    child,
    exited,
    stop() {
      stopping ??= (async () => {
        signal("SIGTERM");
        await Promise.race([exited.catch(() => {}), delay(1_000)]);
        signal("SIGKILL");
        await exited.catch(() => {});
      })().then(release);
      return stopping;
    },
    async wait(timeoutMs: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([exited, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`child ${child.pid} exceeded ${timeoutMs}ms`)), timeoutMs);
        })]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
