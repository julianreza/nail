import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "server-only": fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/helpers/database-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 4,
  },
});
