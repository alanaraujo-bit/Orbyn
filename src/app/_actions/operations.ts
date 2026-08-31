'use server';

import 'server-only';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { alerts } from '@/db/schema';
import { nowIso } from '@/lib/time';
import { idempotencyKey } from '@/lib/ids';
import { toErrorPayload } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { createBackup, pruneBackups } from '@/db/backup';
import { formatBytes } from '@/lib/format';
import {
  pauseCapability,
  resumeCapability,
  RUNTIME_CAPABILITIES,
  type RuntimeCapability,
} from '@/features/system/capabilities';
import { applyDoNotContact, getLead, registerDiscoveredLead, transitionStage } from '@/features/leads/repository';
import { normalizeHandle } from '@/features/leads/handle';
import { CUSTOMER_STAGES, AFFILIATE_STAGES, type Funnel, type PipelineStage } from '@/features/leads/states';
import { cancelJob, cancelJobsForLead, enqueue, getJob, requeueJob } from '@/worker/queue';

/**
 * Operator actions. Every mutation the panel can perform goes through here so
 * it is validated, audited and revalidated consistently.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

function fail(error: unknown): ActionResult {
  const payload = toErrorPayload(error);
  return { ok: false, message: payload.message };
}

const capabilitySchema = z.enum(RUNTIME_CAPABILITIES);

export async function pauseCapabilityAction(capability: string, reason: string): Promise<ActionResult> {
  try {
    const parsed = capabilitySchema.parse(capability) as RuntimeCapability;
    pauseCapability({ capability: parsed, reason: reason.trim() || 'Pausa manual do operador', by: 'operator' });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Capacidade pausada.' };
  } catch (error) {
    return fail(error);
  }
}

export async function resumeCapabilityAction(capability: string): Promise<ActionResult> {
  try {
    const parsed = capabilitySchema.parse(capability) as RuntimeCapability;
    resumeCapability(parsed, 'operator');
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Capacidade retomada.' };
  } catch (error) {
    return fail(error);
  }
}

export async function acknowledgeAlertAction(alertId: string): Promise<ActionResult> {
  try {
    getDb().update(alerts).set({ status: 'acknowledged', updatedAt: nowIso() }).where(eq(alerts.id, alertId)).run();
    recordAudit({ actor: 'operator', action: 'alert.acknowledge', entityType: 'alert', entityId: alertId });
    revalidatePath('/alertas');
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Alerta reconhecido.' };
  } catch (error) {
    return fail(error);
  }
}

export async function resolveAlertAction(alertId: string): Promise<ActionResult> {
  try {
    getDb().update(alerts).set({ status: 'resolved', updatedAt: nowIso() }).where(eq(alerts.id, alertId)).run();
    recordAudit({ actor: 'operator', action: 'alert.resolve', entityType: 'alert', entityId: alertId });
    revalidatePath('/alertas');
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Alerta resolvido.' };
  } catch (error) {
    return fail(error);
  }
}

const importSchema = z.object({
  funnel: z.enum(['customer', 'affiliate']),
  handles: z.string().min(1),
});

export interface ImportResult extends ActionResult {
  created: number;
  duplicates: number;
  suppressed: number;
  invalid: string[];
}

/** Manual import: one handle, URL or @ per line. */
export async function importLeadsAction(funnel: string, handles: string): Promise<ImportResult> {
  const base: ImportResult = { ok: false, message: '', created: 0, duplicates: 0, suppressed: 0, invalid: [] };
  try {
    const input = importSchema.parse({ funnel, handles });
    const lines = input.handles
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      let handle: string;
      try {
        handle = normalizeHandle(line);
      } catch {
        base.invalid.push(line);
        continue;
      }
      const outcome = registerDiscoveredLead({
        handle,
        funnel: input.funnel as Funnel,
        discoverySource: 'operator_import',
      });
      if (outcome.status === 'created') {
        base.created += 1;
        enqueue({
          type: 'qualify_lead',
          payload: { leadId: outcome.lead.id },
          leadId: outcome.lead.id,
          idempotencyKey: idempotencyKey('qualify_lead', outcome.lead.id),
          priority: 1,
        });
      } else if (outcome.status === 'duplicate') {
        base.duplicates += 1;
      } else {
        base.suppressed += 1;
      }
    }

    revalidatePath('/clientes');
    revalidatePath('/afiliados');
    revalidatePath('/');
    return {
      ...base,
      ok: true,
      message: `${base.created} novos, ${base.duplicates} já existentes, ${base.suppressed} em não contatar.`,
    };
  } catch (error) {
    return { ...base, ...fail(error) };
  }
}

export async function scheduleFirstContactAction(leadId: string): Promise<ActionResult> {
  try {
    const lead = getLead(leadId);
    if (lead.doNotContact === 1) return { ok: false, message: 'Lead está em não contatar.' };
    if (lead.channelState !== 'browser_contact_pending') {
      return { ok: false, message: 'Este lead não está aguardando o primeiro contato.' };
    }
    const result = enqueue({
      type: 'send_first_dm',
      payload: { leadId },
      leadId,
      idempotencyKey: idempotencyKey('send_first_dm', leadId),
      priority: lead.priority,
      maxAttempts: 4,
    });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath('/jobs');
    return {
      ok: true,
      message: result.duplicate ? 'Já existe um primeiro contato na fila.' : 'Primeiro contato enfileirado.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function markDoNotContactAction(leadId: string, reason: string): Promise<ActionResult> {
  try {
    applyDoNotContact({
      leadId,
      reason: reason === 'not_interested' ? 'not_interested' : 'operator_block',
      source: 'operator_panel',
      actor: 'operator',
    });
    cancelJobsForLead(leadId, 'marcado como não contatar pelo operador');
    revalidatePath(`/leads/${leadId}`);
    revalidatePath('/clientes');
    revalidatePath('/afiliados');
    return { ok: true, message: 'Lead marcado como não contatar. Nenhuma nova abordagem será feita.' };
  } catch (error) {
    return fail(error);
  }
}

export async function moveStageAction(leadId: string, stage: string): Promise<ActionResult> {
  try {
    const lead = getLead(leadId);
    const allowed = lead.funnel === 'customer' ? CUSTOMER_STAGES : AFFILIATE_STAGES;
    const parsed = z.enum(allowed as unknown as [string, ...string[]]).parse(stage) as PipelineStage;
    transitionStage({ leadId, to: parsed, actor: 'operator', reason: 'alteração manual no painel' });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath('/clientes');
    revalidatePath('/afiliados');
    return { ok: true, message: 'Etapa atualizada.' };
  } catch (error) {
    return fail(error);
  }
}

export async function retryJobAction(jobId: string): Promise<ActionResult> {
  try {
    const job = getJob(jobId);
    requeueJob(job.id);
    recordAudit({ actor: 'operator', action: 'job.retry', entityType: 'job', entityId: jobId });
    revalidatePath('/jobs');
    return { ok: true, message: 'Job reenfileirado.' };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  try {
    cancelJob(jobId, 'cancelado pelo operador');
    recordAudit({ actor: 'operator', action: 'job.cancel', entityType: 'job', entityId: jobId });
    revalidatePath('/jobs');
    return { ok: true, message: 'Job cancelado.' };
  } catch (error) {
    return fail(error);
  }
}

export async function runBackupAction(): Promise<ActionResult> {
  try {
    const backup = await createBackup();
    const pruned = pruneBackups(14);
    recordAudit({ actor: 'operator', action: 'backup.create', entityType: 'database', entityId: backup.file });
    revalidatePath('/configuracoes');
    return {
      ok: true,
      message: `Backup criado (${formatBytes(backup.bytes)})${pruned.length > 0 ? `, ${pruned.length} antigos removidos` : ''}.`,
    };
  } catch (error) {
    return fail(error);
  }
}
