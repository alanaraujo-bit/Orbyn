import Link from 'next/link';
import { getDb } from '@/db/client';
import { listJobs, queueStats } from '@/worker/queue';
import { formatDateTime, formatInteger, formatRelative } from '@/lib/format';
import { Card, EmptyState, PageHeader, Pill, Stat, TableShell, Td, Th, type Tone } from '../_components/ui';
import { ActionButton } from '../_components/action-button';
import { cancelJobAction, retryJobAction } from '../_actions/operations';
import { JOB_STATUS_LABELS, JOB_TYPE_LABELS, labelOr } from '../_lib/labels';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, Tone> = {
  pending: 'neutral',
  running: 'accent',
  succeeded: 'positive',
  failed: 'warning',
  dead: 'danger',
  canceled: 'neutral',
};

export default function JobsPage() {
  const db = getDb();
  const stats = queueStats(db);
  const jobs = listJobs({ limit: 120 }, db);

  return (
    <>
      <PageHeader
        title="Fila de jobs"
        description="Todo trabalho comercial é durável: sobrevive ao reinício do processo e volta a ser executado do ponto em que parou."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Na fila" value={formatInteger(stats.pending)} />
        <Stat label="Executando" value={formatInteger(stats.running)} tone={stats.running > 0 ? 'accent' : 'neutral'} />
        <Stat label="Concluídos" value={formatInteger(stats.succeeded)} tone="positive" />
        <Stat
          label="Esgotados"
          value={formatInteger(stats.dead)}
          tone={stats.dead > 0 ? 'danger' : 'neutral'}
          hint={stats.dead > 0 ? 'Encaminhados à fila de exceções' : undefined}
        />
      </div>

      <Card>
        {jobs.length === 0 ? (
          <EmptyState
            title="Nenhum job registrado"
            description="Os jobs aparecem aqui assim que houver leads a qualificar, abordar ou responder."
          />
        ) : (
          <TableShell
            head={
              <>
                <Th role="title">Tipo</Th>
                <Th role="badge">Status</Th>
                <Th>Tentativas</Th>
                <Th role="meta">Agendado</Th>
                <Th>Erro</Th>
                <Th role="action" className="text-right">Ações</Th>
              </>
            }
          >
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-surface-muted/50">
                <Td>
                  <span className="font-medium text-ink">{labelOr(JOB_TYPE_LABELS, job.type)}</span>
                  {job.leadId ? (
                    <Link href={`/leads/${job.leadId}`} className="inline-flex min-h-11 items-center md:min-h-0 ml-2 text-[11.5px] text-accent-ink hover:underline">
                      lead
                    </Link>
                  ) : null}
                </Td>
                <Td>
                  <Pill tone={STATUS_TONE[job.status] ?? 'neutral'}>{labelOr(JOB_STATUS_LABELS, job.status)}</Pill>
                </Td>
                <Td className="num">
                  {job.attempts}/{job.maxAttempts}
                </Td>
                <Td className="whitespace-nowrap text-ink-muted" title={formatDateTime(job.scheduledAt)}>
                  {formatRelative(job.scheduledAt)}
                </Td>
                <Td className="max-w-[280px]">
                  {job.error ? <span className="text-[11.5px] text-ink-muted">{job.error}</span> : '—'}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    {job.status === 'dead' || job.status === 'canceled' || job.status === 'failed' ? (
                      <ActionButton variant="secondary" action={retryJobAction.bind(null, job.id)}>
                        Reexecutar
                      </ActionButton>
                    ) : null}
                    {job.status === 'pending' || job.status === 'running' ? (
                      <ActionButton variant="ghost" action={cancelJobAction.bind(null, job.id)}>
                        Cancelar
                      </ActionButton>
                    ) : null}
                  </div>
                </Td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>
    </>
  );
}
