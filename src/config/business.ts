import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@/lib/errors';
import { sha256 } from '@/lib/ids';
import { businessConfigSchema, isConfiguredValue, type BusinessConfig } from './schema';

export const BUSINESS_CONFIG_PATH = path.resolve(process.cwd(), 'config', 'business.json');

export interface LoadedBusinessConfig {
  config: BusinessConfig;
  /** Content hash of the raw file; used to detect tampering between runs. */
  fingerprint: string;
  loadedAt: string;
}

interface CacheEntry extends LoadedBusinessConfig {
  mtimeMs: number;
  size: number;
}

let cache: CacheEntry | undefined;

function readConfigFile(): { raw: string; mtimeMs: number; size: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(BUSINESS_CONFIG_PATH);
  } catch {
    throw new AppError('config_invalid', 'config/business.json não foi encontrado.', {
      details: { path: BUSINESS_CONFIG_PATH, hint: 'copie config/business.example.json e preencha os dados oficiais' },
    });
  }
  return { raw: fs.readFileSync(BUSINESS_CONFIG_PATH, 'utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
}

export function loadBusinessConfig(): LoadedBusinessConfig {
  const file = readConfigFile();
  if (cache && cache.mtimeMs === file.mtimeMs && cache.size === file.size) {
    return { config: cache.config, fingerprint: cache.fingerprint, loadedAt: cache.loadedAt };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(file.raw);
  } catch (error) {
    throw new AppError('config_invalid', 'config/business.json não é um JSON válido.', { cause: error });
  }

  const result = businessConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    throw new AppError('config_invalid', `config/business.json inválido:\n- ${issues.join('\n- ')}`, {
      details: { issues },
    });
  }

  const entry: CacheEntry = {
    config: Object.freeze(result.data),
    fingerprint: sha256(file.raw),
    loadedAt: new Date().toISOString(),
    mtimeMs: file.mtimeMs,
    size: file.size,
  };
  cache = entry;
  return { config: entry.config, fingerprint: entry.fingerprint, loadedAt: entry.loadedAt };
}

export function getBusinessConfig(): BusinessConfig {
  return loadBusinessConfig().config;
}

export function resetBusinessConfigCache(): void {
  cache = undefined;
}

/* -------------------------------------------------------------------------- */
/* Capability gating                                                           */
/* -------------------------------------------------------------------------- */

export type BusinessCapabilityId = 'customer_funnel' | 'affiliate_funnel' | 'whatsapp_handoff';

export interface CapabilityStatus {
  id: BusinessCapabilityId;
  enabled: boolean;
  /** Machine-readable reasons the capability is not configured. */
  missing: string[];
}

export function businessCapabilities(config: BusinessConfig = getBusinessConfig()): CapabilityStatus[] {
  const whatsappMissing = isConfiguredValue(config.links.whatsapp) ? [] : ['links.whatsapp'];

  const customerMissing: string[] = [...whatsappMissing];
  if (config.verifiedClaims.length === 0) customerMissing.push('verifiedClaims');
  if (config.icp.keywords.length === 0) customerMissing.push('icp.keywords');
  if (config.icp.segments.length === 0) customerMissing.push('icp.segments');

  const affiliateMissing: string[] = [];
  if (!isConfiguredValue(config.affiliateProgram.groupLink)) affiliateMissing.push('affiliateProgram.groupLink');
  if (config.affiliateProgram.verifiedProgramClaims.length === 0) {
    affiliateMissing.push('affiliateProgram.verifiedProgramClaims');
  }
  if (config.affiliateProgram.topics.length === 0) affiliateMissing.push('affiliateProgram.topics');

  return [
    { id: 'customer_funnel', enabled: customerMissing.length === 0, missing: customerMissing },
    { id: 'affiliate_funnel', enabled: affiliateMissing.length === 0, missing: affiliateMissing },
    { id: 'whatsapp_handoff', enabled: whatsappMissing.length === 0, missing: whatsappMissing },
  ];
}

export function isCapabilityEnabled(id: BusinessCapabilityId, config?: BusinessConfig): boolean {
  return businessCapabilities(config).some((capability) => capability.id === id && capability.enabled);
}

export function requireCapability(id: BusinessCapabilityId, config?: BusinessConfig): void {
  const status = businessCapabilities(config).find((capability) => capability.id === id);
  if (!status || !status.enabled) {
    throw new AppError('capability_disabled', `Capacidade "${id}" não configurada.`, {
      details: { capability: id, missing: status?.missing ?? ['unknown'] },
    });
  }
}

/**
 * Outbound-safe link resolution. Returns `null` instead of a placeholder so no
 * caller can ever put "A DEFINIR" in front of a lead.
 */
export function outboundLink(kind: 'whatsapp' | 'affiliate_group', config: BusinessConfig = getBusinessConfig()): string | null {
  const value = kind === 'whatsapp' ? config.links.whatsapp : config.affiliateProgram.groupLink;
  return isConfiguredValue(value) ? value : null;
}
