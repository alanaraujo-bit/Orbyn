import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { capabilityReport } from '@/features/system/capabilities';
import { queueStats } from '@/worker/queue';
import { loadBusinessConfig } from '@/config/business';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Liveness plus a machine-readable view of what is currently operational. */
export async function GET(): Promise<Response> {
  const db = getDb();
  const { config, fingerprint } = loadBusinessConfig();

  return NextResponse.json({
    status: 'ok',
    company: config.company.name,
    configFingerprint: fingerprint.slice(0, 12),
    capabilities: capabilityReport(db).map((entry) => ({
      id: entry.id,
      configured: entry.configured,
      paused: entry.paused,
      usable: entry.usable,
    })),
    jobs: queueStats(db),
  });
}
