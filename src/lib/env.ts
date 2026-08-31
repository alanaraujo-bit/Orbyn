import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { parseOperatingHours, type OperatingHours } from './time';

loadDotenv({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const optionalSecret = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

const positiveInt = (fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().positive());

const nonNegativeNumber = (fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().nonnegative());

const optionalNumber = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : Number(value)))
    .pipe(z.number().nonnegative().optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    OPENAI_API_KEY: optionalSecret,
    OPENAI_MODEL: z.string().trim().min(1).default('gpt-5.1'),
    OPENAI_MODEL_FAST: z.string().trim().min(1).default('gpt-5.1-mini'),
    OPENAI_MONTHLY_BUDGET_USD: nonNegativeNumber(25),
    // Cost is never guessed: leave these empty and the panel reports the cost as
    // "preco nao configurado" instead of inventing a number.
    OPENAI_PRICE_INPUT_PER_1M: optionalNumber(),
    OPENAI_PRICE_CACHED_INPUT_PER_1M: optionalNumber(),
    OPENAI_PRICE_OUTPUT_PER_1M: optionalNumber(),
    OPENAI_FAST_PRICE_INPUT_PER_1M: optionalNumber(),
    OPENAI_FAST_PRICE_CACHED_INPUT_PER_1M: optionalNumber(),
    OPENAI_FAST_PRICE_OUTPUT_PER_1M: optionalNumber(),

    CHROME_CDP_URL: optionalSecret,
    CHROME_PROFILE_DIR: z.string().trim().default('./.chrome-profile'),

    /**
     * Password for the operator panel. The tunnel forwards every path, not just
     * the webhook, so without this the panel — lead data, message contents and
     * the buttons that send DMs — answers to anyone who finds the public URL.
     */
    PANEL_PASSWORD: optionalSecret,

    INSTAGRAM_APP_SECRET: optionalSecret,
    INSTAGRAM_PAGE_ACCESS_TOKEN: optionalSecret,
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: optionalSecret,
    INSTAGRAM_BUSINESS_ACCOUNT_ID: optionalSecret,
    /** Public HTTPS address Meta is configured to deliver to; enables the reachability watchdog. */
    PUBLIC_WEBHOOK_URL: optionalSecret,

    DATABASE_URL: z.string().trim().default('file:./data/orbyn.db'),
    BACKUP_DIR: z.string().trim().default('./backups'),
    ARTIFACTS_DIR: z.string().trim().default('./screenshots'),

    MAX_DMS_PER_DAY: positiveInt(30),
    MIN_SECONDS_BETWEEN_DMS: positiveInt(90),
    MAX_SECONDS_BETWEEN_DMS: positiveInt(240),
    OPERATING_HOURS: z.string().trim().default('09:00-20:00'),
    OPERATING_TIMEZONE: z.string().trim().default('America/Belem'),

    WEB_PORT: positiveInt(4310),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    WORKER_POLL_INTERVAL_MS: positiveInt(2000),
    DATA_RETENTION_DAYS: positiveInt(365),

    ALLOW_REAL_DM_SMOKE_TEST: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === 'true'),
  })
  .superRefine((value, ctx) => {
    if (value.MIN_SECONDS_BETWEEN_DMS > value.MAX_SECONDS_BETWEEN_DMS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MIN_SECONDS_BETWEEN_DMS'],
        message: 'MIN_SECONDS_BETWEEN_DMS must be <= MAX_SECONDS_BETWEEN_DMS',
      });
    }
    try {
      parseOperatingHours(value.OPERATING_HOURS);
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['OPERATING_HOURS'], message: (error as Error).message });
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: value.OPERATING_TIMEZONE });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['OPERATING_TIMEZONE'], message: 'unknown IANA timezone' });
    }
    if (value.PUBLIC_WEBHOOK_URL !== undefined) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(value.PUBLIC_WEBHOOK_URL);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_WEBHOOK_URL'], message: 'must be a valid URL' });
      }
      // Meta refuses to deliver to anything but HTTPS, so a non-HTTPS value here
      // could only ever describe an address Meta is not actually using.
      if (parsed && parsed.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_WEBHOOK_URL'], message: 'must be an https:// URL' });
      }
    }
    if (value.CHROME_CDP_URL !== undefined) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(value.CHROME_CDP_URL);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['CHROME_CDP_URL'], message: 'must be a valid URL' });
      }
      if (parsed && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]') {
        ctx.addIssue({
          code: 'custom',
          path: ['CHROME_CDP_URL'],
          message: 'the Chrome debugging endpoint must stay on loopback (127.0.0.1)',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam: forces the next getEnv() call to re-read process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function operatingHours(): OperatingHours {
  return parseOperatingHours(getEnv().OPERATING_HOURS);
}

export function databaseFilePath(): string {
  const raw = getEnv().DATABASE_URL;
  const withoutScheme = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  // Orbyn is a local Node application: these paths are operator-configured and
  // resolved from the repository root on purpose.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), withoutScheme);
}

export interface EnvCapabilityState {
  openai: boolean;
  browser: boolean;
  instagramApi: boolean;
  instagramWebhook: boolean;
}

export function envCapabilities(env: Env = getEnv()): EnvCapabilityState {
  return {
    openai: Boolean(env.OPENAI_API_KEY),
    browser: Boolean(env.CHROME_CDP_URL),
    instagramApi: Boolean(env.INSTAGRAM_PAGE_ACCESS_TOKEN && env.INSTAGRAM_BUSINESS_ACCOUNT_ID),
    instagramWebhook: Boolean(env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN),
  };
}
