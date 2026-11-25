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
            ENVIRONMENT: 'test',
            RESEARCH_ENABLED: 'true',
            PROVIDER: 'fixture',
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
