import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration specs drive one real Chrome each; running them in parallel would make
    // the memory problem this project exists to fix show up in its own CI.
    fileParallelism: false,
  },
});
