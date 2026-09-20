import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Fake env so src/config/env.ts loads without a real .env or database.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      JWT_ACCESS_SECRET: "test-access-secret-test-access-secret",
      JWT_REFRESH_SECRET: "test-refresh-secret-test-refresh-secret",
      JWT_ACCESS_TTL: "15m",
      JWT_REFRESH_TTL: "30d",
      JWT_ISSUER: "cstam-identity-test",
      BCRYPT_SALT_ROUNDS: "4", // fast hashing in tests
    },
  },
});
