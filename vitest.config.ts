// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
// @ts-expect-error: plain JavaScript build script, without type declarations.
import { buildTemplates } from "./scripts/build-templates.mjs";

// The edge imports the minified waiting page: build it before the tests.
buildTemplates();

// Test-only secrets (never used outside tests).
const TEST_KEY = btoa("test-key-0123456789-0123456789-0123456789");

export default defineConfig({
  test: {
    // The on-disk module cache is not readable from the Workers runtime pool.
    fsModuleCache: false,
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      { test: { name: "sim", include: ["test/sim/**/*.test.ts"], environment: "node", testTimeout: 120_000 } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler/test.jsonc" },
            miniflare: { bindings: { WR_BOOTSTRAP_CONFIG: JSON.stringify({ admissionsPerMinute: 60, sessionMinutes: 10 }) } },
          }),
        ],
        test: { name: "coordinator", include: ["test/integration/coordinator/**/*.test.ts"] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler/test.jsonc" },
            miniflare: {
              bindings: {
                WR_KEYS: JSON.stringify({ 1: TEST_KEY }),
                WR_KEY_CURRENT: "1",
                WR_ADMIN_TOKEN: "test-admin-token",
                WR_METRICS_USER: "prometheus",
                WR_METRICS_PASSWORD: "test-metrics-password",
                WR_DASHBOARD_USER: "ops",
                WR_DASHBOARD_PASSWORD: "test-dashboard-password",
                WR_BYPASS_SECRET: "test-bypass-secret",
                WR_BOT_SECRET: "test-bot-secret-0123456789-0123456789",
              },
              // Stand-in origin: echoes what it received, with cacheable headers.
              outboundService: async (req: Request) => {
                const u = new URL(req.url);
                return new Response(`origin ${u.pathname}${u.search}`, {
                  headers: {
                    "Cache-Control": "public, max-age=60",
                    "X-Origin": "1",
                    "X-Saw-Bypass": req.headers.has("x-wr-bypass") ? "yes" : "no",
                    "X-Saw-Bot": req.headers.has("x-wr-bot") ? "yes" : "no",
                  },
                });
              },
            },
          }),
        ],
        test: { name: "edge", include: ["test/integration/edge/**/*.test.ts"] },
      },
    ],
  },
});
