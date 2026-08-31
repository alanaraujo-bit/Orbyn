import { z } from 'zod';

/**
 * `config/business.json` is the operator-owned source of truth for every real
 * business fact. Nothing in this repository writes to it.
 */

export const PLACEHOLDER_TOKENS = ['a definir', 'tbd', 'to be defined', 'preencher', 'todo'] as const;

/** A value counts as configured only when it is a real, non-placeholder string. */
export function isConfiguredValue(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return !PLACEHOLDER_TOKENS.includes(normalized as (typeof PLACEHOLDER_TOKENS)[number]);
}

const filledString = z.string().trim().min(1);

/** Accepts placeholders at parse time; capability gating decides usability. */
const gatedString = z.string().trim().nullable().default(null);

export const businessConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.object({
      name: filledString,
      role: filledString,
    }),
    company: z.object({
      name: filledString,
      website: z.url(),
      instagramHandle: z
        .string()
        .trim()
        .regex(/^@[A-Za-z0-9._]{1,30}$/, 'instagramHandle must look like @handle'),
    }),
    links: z.object({
      whatsapp: gatedString,
    }),
    positioning: z.object({
      oneLinePitch: filledString,
      howItWorks: z.array(filledString).min(1),
    }),
    revenueModel: filledString,
    marketJargon: z
      .array(z.object({ term: filledString, definition: filledString }))
      .default([]),
    verifiedClaims: z.array(filledString).default([]),
    unverifiedClaims: z.array(filledString).default([]),
    icp: z.object({
      segments: z.array(filledString).min(1),
      keywords: z.array(filledString).min(1),
    }),
    affiliateProgram: z.object({
      topics: z.array(filledString).default([]),
      groupLink: gatedString,
      verifiedProgramClaims: z.array(filledString).default([]),
    }),
    geography: filledString,
  })
  .strict();

export type BusinessConfig = z.infer<typeof businessConfigSchema>;
