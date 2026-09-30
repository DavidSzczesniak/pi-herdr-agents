import { onTestFinished } from "vitest";
import { finishCleanup } from "./cleanup.ts";
import { onProcessExit } from "./exit.ts";

export function ownTestCleanup(actions: () => readonly (() => unknown)[], exitActions: readonly (() => void)[]) {
  const release = exitActions.map(onProcessExit);
  let closing: Promise<void> | undefined;
  let reportedByBody = false;
  const close = () => closing ??= finishCleanup([], actions()).then(() => { for (const remove of release) remove(); });
  onTestFinished(async () => { if (!reportedByBody) await close(); }, 60_000);
  return {
    async finish(errors: readonly unknown[]) {
      try { await finishCleanup(errors, [close]); }
      finally { reportedByBody = true; }
    },
  };
}
