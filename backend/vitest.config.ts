import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    env: {
      NODE_ENV: "test",
      JWT_SECRET: "test-secret",
      CHAIN_MODE: "off",
      STORAGE_DRIVER: "memory",
      DATABASE_URL: "", // tests always run on embedded PGlite
      PLATFORM_FEE_BPS: "200",
      REVIEW_TIMEOUT_SECONDS: "604800",
      ADMIN_ADDRESSES: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    }
  }
});
