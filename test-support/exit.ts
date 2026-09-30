const cleanups = new Set<() => void>();

function detach() {
  process.off("exit", flush);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
function flush() {
  const pending = [...cleanups].reverse();
  cleanups.clear();
  detach();
  for (const cleanup of pending) {
    try { cleanup(); }
    catch (error) { console.error(error); process.exitCode ||= 1; }
  }
}
function forward(signal: "SIGINT" | "SIGTERM", listener: () => void) {
  const handled = process.listeners(signal).some(other => other !== listener);
  flush();
  if (!handled) process.kill(process.pid, signal);
}
function interrupt() { forward("SIGINT", interrupt); }
function terminate() { forward("SIGTERM", terminate); }

export function onProcessExit(cleanup: () => void): () => void {
  if (!cleanups.size) {
    process.prependListener("exit", flush);
    process.prependListener("SIGINT", interrupt);
    process.prependListener("SIGTERM", terminate);
  }
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    if (!cleanups.size) detach();
  };
}
