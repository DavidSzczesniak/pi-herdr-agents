import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const dependencyLinkScript = fileURLToPath(new URL("./link-guard.sh", import.meta.url));

export function removeBorrowedDependencies(cwd: string): string | undefined {
  const result = spawnSync("/bin/sh", [dependencyLinkScript, cwd], { encoding: "utf8" });
  return result.status === 2 ? result.stderr.trim() : undefined;
}
