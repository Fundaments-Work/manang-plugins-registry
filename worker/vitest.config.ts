import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the real Workers runtime, via miniflare) with the
// Worker's own R2 bucket and Durable Object bindings, all in memory. The
// per-address rate limit is switched off here and exercised on its own.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { RATE_REQS_PER_MIN: "0" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
