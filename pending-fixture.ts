import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicit native-test fixture. Load after index.ts; never load in ordinary workers. */
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event.prompt.startsWith("[ds-task ")) return;
    if (ctx.hasUI) ctx.ui.notify("Pending fixture holding before agent_start; no provider request", "info");
    await new Promise<void>(() => {});
  });
}
