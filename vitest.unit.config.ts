import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/unit/setup.ts"],
  },
});
