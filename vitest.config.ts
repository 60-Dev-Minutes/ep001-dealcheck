import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Pin every variable so local .dev.vars (which may hold real credentials) never leaks into tests.
            ENVIRONMENT: 'test',
            RESEARCH_ENABLED: 'true',
            PROVIDER: 'fixture',
            ANTHROPIC_MODEL: 'claude-haiku-5-5',
            DAILY_BUDGET_NZD: '25',
            QUOTA_TOTAL: '10',
            GLOBAL_CONCURRENCY: '5',
            BUDGET_TIMEZONE: 'Pacific/Auckland',
            QUOTA_KEY_VERSION: '1',
            QUOTA_HMAC_SECRET: 'test-quota-secret-not-real-000000000000',
            SESSION_SECRET: 'test-session-secret-not-real-0000000000',
            TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
            TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
            ANTHROPIC_API_KEY: 'test-key-not-real',
          },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] },
  };
});
