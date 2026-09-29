import { type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type ProcessExit = { code: number; signal: null } | { code: null; signal: NodeJS.Signals };

export function ownChild(child: ChildProcess, processGroup = false) {
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) resolve({ code: null, signal });
      else if (code !== null) resolve({ code, signal: null });
      else reject(new Error("child exited without code or signal"));
    });
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
  async function wait(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`child ${child.pid} exceeded ${timeoutMs}ms`)), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  let stopping: Promise<void> | undefined;
  return {
    child,
    exited,
    wait,
    stop() {
      stopping ??= (async () => {
        if (!child.pid) { await exited.catch(() => {}); return; }
        signal("SIGTERM");
        await Promise.race([exited.catch(() => {}), delay(1_000, undefined, { ref: false })]);
        signal("SIGKILL");
        await wait(5_000);
      })();
      return stopping;
    },
  };
}
