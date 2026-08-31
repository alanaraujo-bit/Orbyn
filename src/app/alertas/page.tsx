import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { alerts } from '@/db/schema';
import { formatDateTime, formatRelative } from '@/lib/format';
import { Card, EmptyState, PageHeader, Pill, TableShell, Td, Th, type Tone } from '../_components/ui';
import { ActionButton } from '../_components/action-button';
import { acknowledgeAlertAction, resolveAlertAction } from '../_actions/operations';
import { ALERT_KIND_LABELS, ALERT_SEVERITY_LABELS, ALERT_STATUS_LABELS, labelOr } from '../_lib/labels';

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, Tone> = { info: 'neutral', warning: 'warning', critical: 'danger' };

export default function AlertsPage() {
  const db = getDb();
  const rows = db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(150).all();
  const open = rows.filter((row) => row.status === 'open');
  const handled = rows.filter((row) => row.status !== 'open');

  return (
    <>
      <PageHeader
        title="Alertas e exceções"
        description="Falhas de integração, sinais de segurança, bloqueios de política e jobs esgotados chegam aqui."
      />

      <Card title="Abertos" description="Exigem uma decisão do operador." className="mb-4">
        {open.length === 0 ? (
          <EmptyState title="Nenhum alerta aberto" description="A operação está seguindo sem exceções pendentes." />
        ) : (
          <TableShell
            head={
              <>
                <Th role="badge">Severidade</Th>
                <Th>Tipo</Th>
                <Th role="title">Alerta</Th>
                <Th role="meta">Quando</Th>
                <Th role="action" className="text-right">Ações</Th>
              </>
            }
          >
            {open.map((alert) => (
              <tr key={alert.id}>
                <Td>
                  <Pill tone={SEVERITY_TONE[alert.severity] ?? 'neutral'}>
                    {labelOr(ALERT_SEVERITY_LABELS, alert.severity)}
                  </Pill>
                </Td>
                <Td className="text-ink-muted">{labelOr(ALERT_KIND_LABELS, alert.kind)}</Td>
                <Td>
                  <p className="font-medium text-ink">{alert.title}</p>
                  {alert.detail ? <p className="text-[11.5px] text-ink-muted">{alert.detail}</p> : null}
                  {alert.leadId ? (
                    <Link
                      href={`/leads/${alert.leadId}`}
                      className="inline-flex min-h-11 items-center md:min-h-0 text-[11.5px] text-accent-ink hover:underline"
                    >
                      ver lead
                    </Link>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap text-ink-muted" title={formatDateTime(alert.createdAt)}>
                  {formatRelative(alert.createdAt)}
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <ActionButton variant="ghost" action={acknowledgeAlertAction.bind(null, alert.id)}>
                      Reconhecer
                    </ActionButton>
                    <ActionButton variant="secondary" action={resolveAlertAction.bind(null, alert.id)}>
                      Resolver
                    </ActionButton>
                  </div>
                </Td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>

      <Card title="Histórico" description="Alertas reconhecidos e resolvidos.">
        {handled.length === 0 ? (
          <EmptyState title="Sem histórico" description="Nenhum alerta foi tratado ainda." />
        ) : (
          <TableShell
            head={
              <>
                <Th role="badge">Status</Th>
                <Th role="title">Alerta</Th>
                <Th role="meta" className="text-right">Quando</Th>
              </>
            }
          >
            {handled.map((alert) => (
              <tr key={alert.id}>
                <Td>
                  <Pill tone={alert.status === 'resolved' ? 'positive' : 'neutral'}>
                    {labelOr(ALERT_STATUS_LABELS, alert.status)}
                  </Pill>
                </Td>
                <Td>{alert.title}</Td>
                <Td className="text-right whitespace-nowrap text-ink-muted">{formatRelative(alert.updatedAt)}</Td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>
    </>
  );
}
