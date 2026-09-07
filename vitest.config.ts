import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cairn/core": r("./packages/core/src/index.ts"),
      "@cairn/ai": r("./packages/ai/src/index.ts"),
      "@cairn/executor": r("./packages/executor/src/index.ts")
    }
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
    server: {
      deps: { inline: [/zod/] }
    }
  }
});
