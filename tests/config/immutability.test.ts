import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../helpers/db';
import { makeLead } from '../helpers/factories';
import { BUSINESS_CONFIG_PATH, businessCapabilities, getBusinessConfig } from '@/config/business';
import { businessConfigSchema, isConfiguredValue } from '@/config/schema';
import { sendFirstContact } from '@/features/campaigns/first-contact';
import { SimulatedBrowserDriver } from '@/integrations/browser/simulated-driver';
import { listStrategy, writeStrategy } from '@/features/experiments/strategy-store';

withTestDatabase();

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('config/business.json is operator-owned', () => {
  it('is never opened for writing anywhere in the source tree', () => {
    const writeApis = /(writeFileSync|writeFile|appendFile|createWriteStream|copyFileSync|rm|unlink|truncate)\s*\(/;
    const offenders: string[] = [];

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const content = fs.readFileSync(file, 'utf8');
      if (!content.includes('business.json') && !content.includes('BUSINESS_CONFIG_PATH')) continue;
      for (const line of content.split('\n')) {
        if (writeApis.test(line) && (line.includes('business.json') || line.includes('BUSINESS_CONFIG_PATH'))) {
          offenders.push(`${path.relative(process.cwd(), file)}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('exposes only read paths from the config module', () => {
    const configModule = fs.readFileSync(path.join(SOURCE_ROOT, 'config', 'business.ts'), 'utf8');
    expect(configModule).toContain('readFileSync');
    expect(configModule).not.toContain('writeFileSync');
  });

  it('keeps learned strategy in a separate store', () => {
    writeStrategy('icp_keyword_weights', { 'automação de processos': 1.4 }, 'optimizer');
    const stored = listStrategy();
    expect(stored.map((row) => row.key)).toContain('icp_keyword_weights');

    // The official record on disk is untouched by that write.
    const raw = fs.readFileSync(BUSINESS_CONFIG_PATH, 'utf8');
    expect(raw).not.toContain('icp_keyword_weights');
    expect(businessConfigSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  });

  it('rejects unknown fields, so nothing can smuggle learned data into it', () => {
    const config = { ...(JSON.parse(fs.readFileSync(BUSINESS_CONFIG_PATH, 'utf8')) as object), learned: { a: 1 } };
    expect(businessConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('placeholder detection', () => {
  it('treats every unfilled form of a value as not configured', () => {
    expect(isConfiguredValue('A DEFINIR')).toBe(false);
    expect(isConfiguredValue('a definir')).toBe(false);
    expect(isConfiguredValue('  ')).toBe(false);
    expect(isConfiguredValue(null)).toBe(false);
    expect(isConfiguredValue(undefined)).toBe(false);
    expect(isConfiguredValue('https://chat.whatsapp.com/abc')).toBe(true);
  });
});

describe('affiliate funnel gating', () => {
  it('is reported as awaiting configuration', () => {
    const affiliate = businessCapabilities().find((entry) => entry.id === 'affiliate_funnel');
    expect(affiliate?.enabled).toBe(false);
  });

  it('refuses to contact an affiliate lead while the program is incomplete', async () => {
    const lead = makeLead({ funnel: 'affiliate', bio: 'Falo sobre empreendedorismo, negócios e gestão empresarial.', qualify: false });
    await expect(
      sendFirstContact({ leadId: lead.id, mode: 'simulated', driver: new SimulatedBrowserDriver(), jobId: 'job_aff' }),
    ).rejects.toMatchObject({ code: 'capability_disabled' });
  });

  it('enables the affiliate funnel once the operator fills the program in', () => {
    const config = getBusinessConfig();
    const completed = {
      ...config,
      affiliateProgram: {
        ...config.affiliateProgram,
        groupLink: 'https://chat.whatsapp.com/exemplo',
        verifiedProgramClaims: ['O programa de afiliados da Aionixdev possui grupo oficial de acompanhamento'],
      },
    };
    const parsed = businessConfigSchema.safeParse(completed);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const affiliate = businessCapabilities(parsed.data).find((entry) => entry.id === 'affiliate_funnel');
    expect(affiliate?.enabled).toBe(true);
  });
});
