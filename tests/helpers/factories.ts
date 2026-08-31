import type { LeadRow } from '@/db/schema';
import { qualifyLead, registerDiscoveredLead } from '@/features/leads/repository';
import type { Funnel } from '@/features/leads/states';

let counter = 0;

export interface LeadFactoryOptions {
  handle?: string;
  funnel?: Funnel;
  bio?: string;
  category?: string;
  qualify?: boolean;
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
  return qualified.lead;
}
