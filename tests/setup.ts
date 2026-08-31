import { beforeEach } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { resetBusinessConfigCache } from '@/config/business';

// Deterministic baseline for every test file. Individual tests may override a
// variable and call `resetEnvCache()` again.
// NODE_ENV is set to `test` by the runner itself.
process.env.LOG_LEVEL = 'error';
process.env.OPERATING_TIMEZONE = 'America/Belem';
process.env.OPERATING_HOURS = '00:00-23:59';
process.env.MAX_DMS_PER_DAY = '30';
process.env.MIN_SECONDS_BETWEEN_DMS = '1';
process.env.MAX_SECONDS_BETWEEN_DMS = '2';
process.env.OPENAI_API_KEY = '';
process.env.CHROME_CDP_URL = '';
process.env.INSTAGRAM_APP_SECRET = '';
process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = '';
process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = '';
process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = '';

beforeEach(() => {
  resetEnvCache();
  resetBusinessConfigCache();
});
