import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: true,
    sequence: { concurrent: false },
    allowOnly: false,
  },
});
