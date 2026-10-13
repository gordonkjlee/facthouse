import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "tests/ui", outputDir: "test-results/ui-artifacts", reporter: "line" });
