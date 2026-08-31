import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { leads, type LeadRow } from '@/db/schema';
import { qualifyLead, registerDiscoveredLead } from '@/features/leads/repository';
import type { Funnel } from '@/features/leads/states';
import type { ProfileStudy } from '@/features/leads/profile-study';

let counter = 0;

export interface LeadFactoryOptions {
  handle?: string;
  funnel?: Funnel;
  bio?: string;
  category?: string;
  qualify?: boolean;
  /**
   * The activity the study established. Nothing is contacted before the system
   * can say what the business does, so a lead that reaches the outreach backlog
   * has always been studied - the factory records that by default. Pass `null`
   * for the unstudied case.
   */
  activity?: string | null;
}

/** Stores a study result the way `studyProfile` does, without calling a model. */
export function recordStudy(lead: LeadRow, activity: string): LeadRow {
  const study: ProfileStudy = {
    activity,
    evidence: [activity],
    reason: null,
    studiedAt: new Date().toISOString(),
  };
  const snapshot = { ...(JSON.parse(lead.profileSnapshot) as Record<string, unknown>), study };
  const profileSnapshot = JSON.stringify(snapshot);
  getDb().update(leads).set({ profileSnapshot }).where(eq(leads.id, lead.id)).run();
  return { ...lead, profileSnapshot };
}

/** Creates a lead that comfortably matches the configured ICP. */
export function makeLead(options: LeadFactoryOptions = {}): LeadRow {
  counter += 1;
  const outcome = registerDiscoveredLead({
    handle: options.handle ?? `lead_teste_${counter}`,
    displayName: 'Empresa Teste',
    bio:
      options.bio ??
      'Distribuidora que precisa de automação de processos, gestão empresarial e um sistema empresarial sob medida.',
    category: options.category ?? 'Distribuidora',
    location: 'Belém, Brasil',
    funnel: options.funnel ?? 'customer',
    discoverySource: 'test',
    sourceKeyword: 'automação de processos',
    isBusinessAccount: true,
  });
  if (outcome.status !== 'created') throw new Error(`factory expected a new lead, got ${outcome.status}`);
  if (options.qualify === false) return outcome.lead;
  const qualified = qualifyLead(outcome.lead.id);
  if (!qualified.qualified) throw new Error(`factory lead did not qualify (score ${qualified.score})`);

  const activity = options.activity === undefined ? 'automação de processos' : options.activity;
  if (activity === null) return qualified.lead;
  return recordStudy(qualified.lead, activity);
}
