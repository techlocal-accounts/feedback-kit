import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

export default defineConfig({
  resolve: {alias: {"@techlocal-accounts/feedback-core": fileURLToPath(new URL("./packages/feedback-core/src/index.ts", import.meta.url))}},
  test: {include: ["packages/**/*.test.ts"], environment: "jsdom"},
});
