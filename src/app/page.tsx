import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { alerts, leads } from '@/db/schema';
import { getBusinessConfig } from '@/config/business';
import { capabilityReport } from '@/features/system/capabilities';
import { costMetrics, funnelCounts, pipelineTotals, ratio, todayStats } from '@/features/analytics/metrics';
import { queueStats } from '@/worker/queue';
import { formatInteger, formatPercent, formatRelative, formatUsd } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { Card, EmptyState, PageHeader, Pill, Stat, Td, TableShell, Th } from './_components/ui';
import { CHANNEL_STATE_LABELS, STAGE_LABELS, labelOr, missingLabel, CAPABILITY_LABELS } from './_lib/labels';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const db = getDb();
  const env = getEnv();
  const config = getBusinessConfig();

  const customer = pipelineTotals('customer', db);
  const stages = funnelCounts('customer', db);
  const today = todayStats(new Date(), db);
  const cost = costMetrics(db);
  const jobs = queueStats(db);
  const capabilities = capabilityReport(db);

  const replyRate = ratio(customer.replied, customer.contacted);
  const handoffRate = ratio(customer.handedOff, customer.replied);

  const needsAttention = db
    .select()
    .from(leads)
    .where(eq(leads.channelState, 'human_review_required'))
    .orderBy(desc(leads.updatedAt))
    .limit(6)
    .all();

  const openAlerts = db.select().from(alerts).where(eq(alerts.status, 'open')).orderBy(desc(alerts.createdAt)).limit(5).all();
  const blocked = capabilities.filter((entry) => !entry.configured && entry.id !== 'global');

  return (
    <>
      <PageHeader
        title="Visão geral"
        description={`Prospecção de ${config.company.name} no Instagram — ${env.OPERATING_HOURS} (${env.OPERATING_TIMEZONE}).`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="DMs hoje"
          value={`${formatInteger(today.dmsSent)} / ${formatInteger(today.dailyCap)}`}
          hint={`Teto do operador: ${formatInteger(env.MAX_DMS_PER_DAY)} por dia`}
          tone={today.remaining === 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Taxa de resposta"
          value={replyRate === null ? '—' : formatPercent(replyRate, 1)}
          hint={replyRate === null ? 'Sem abordagens registradas ainda' : `${customer.replied} de ${customer.contacted} abordados`}
        />
        <Stat
          label="Encaminhados ao WhatsApp"
          value={formatInteger(customer.handedOff)}
          hint={handoffRate === null ? 'Sem respostas ainda' : `${formatPercent(handoffRate, 1)} de quem respondeu`}
        />
        <Stat
          label="Custo de IA no mês"
          value={cost.hasUnpricedCalls && cost.spentUsd === 0 ? '—' : formatUsd(cost.spentUsd)}
          hint={
            cost.hasUnpricedCalls
              ? 'Preço por token não configurado no .env'
              : `Orçamento: ${formatUsd(cost.budgetUsd)}`
          }
          tone={cost.exceeded ? 'danger' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Funil de clientes" description="Leads por etapa comercial.">
          {customer.discovered === 0 ? (
            <EmptyState
              title="Nenhum lead ainda"
              description="Importe uma lista de perfis no funil de clientes ou habilite a descoberta automática pelo navegador para começar."
              action={
                <Link
                  href="/clientes"
                  className="inline-flex min-h-11 items-center rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 md:min-h-0"
                >
                  Abrir funil de clientes
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {stages.map((entry) => {
                const share = customer.discovered > 0 ? entry.count / customer.discovered : 0;
                return (
                  /*
                   * Grid, not a wrapping flex row: a flex child at `w-full`
                   * makes its own width depend on the row it is sizing, and
                   * Chrome resolves that by letting the card run 32px past the
                   * screen. An explicit `minmax(0, 1fr)` track cannot.
                   */
                  <li
                    key={entry.stage}
                    className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-3 gap-y-1 px-4 py-2 md:flex"
                  >
                    <span className="col-span-2 min-w-0 text-[12.5px] text-ink md:col-span-1 md:w-52 md:shrink-0">
                      {STAGE_LABELS[entry.stage]}
                    </span>
                    <span className="h-1.5 min-w-0 overflow-hidden rounded-full bg-surface-muted md:flex-1">
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{ width: `${Math.max(share * 100, entry.count > 0 ? 2 : 0)}%` }}
                      />
                    </span>
                    <span className="num w-10 shrink-0 text-right text-[12.5px] font-medium text-ink">
                      {formatInteger(entry.count)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Fila de jobs" description="Trabalho durável pendente e em execução.">
            <dl className="grid grid-cols-3 divide-x divide-line">
              {[
                { label: 'Na fila', value: jobs.pending },
                { label: 'Executando', value: jobs.running },
                { label: 'Esgotados', value: jobs.dead },
              ].map((entry) => (
                <div key={entry.label} className="px-4 py-3">
                  <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{entry.label}</dt>
                  <dd className="num mt-0.5 text-[18px] font-semibold text-ink">{formatInteger(entry.value)}</dd>
                </div>
              ))}
            </dl>
            <div className="border-t border-line px-4 py-2">
              <Link href="/jobs" className="inline-flex min-h-11 items-center md:min-h-0 text-[12.5px] text-accent-ink hover:underline">
                Ver fila completa
              </Link>
            </div>
          </Card>

          <Card title="Alertas abertos">
            {openAlerts.length === 0 ? (
              <EmptyState title="Nada exigindo atenção" description="Nenhum alerta aberto no momento." />
            ) : (
              <ul className="divide-y divide-line">
                {openAlerts.map((alert) => (
                  <li key={alert.id} className="flex items-start gap-3 px-4 py-2.5">
                    <Pill tone={alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'neutral'}>
                      {alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Info'}
                    </Pill>
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-ink">{alert.title}</p>
                      <p className="text-[11.5px] text-ink-faint">{formatRelative(alert.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-line px-4 py-2">
              <Link href="/alertas" className="inline-flex min-h-11 items-center md:min-h-0 text-[12.5px] text-accent-ink hover:underline">
                Ver alertas e exceções
              </Link>
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Aguardando decisão humana" description="Conversas que a IA não pode concluir sozinha.">
          {needsAttention.length === 0 ? (
            <EmptyState title="Nenhuma conversa parada" description="Nada aguardando revisão humana neste momento." />
          ) : (
            <TableShell
              head={
                <>
                  <Th role="title">Perfil</Th>
                  <Th>Etapa</Th>
                  <Th>Canal</Th>
                  <Th role="meta" className="text-right">Atualizado</Th>
                </>
              }
            >
              {needsAttention.map((lead) => (
                <tr key={lead.id} className="hover:bg-surface-muted/60">
                  <Td>
                    <Link href={`/leads/${lead.id}`} className="inline-flex min-h-11 items-center md:min-h-0 font-medium text-accent-ink hover:underline">
                      @{lead.handle}
                    </Link>
                  </Td>
                  <Td>{labelOr(STAGE_LABELS, lead.pipelineStage)}</Td>
                  <Td>{labelOr(CHANNEL_STATE_LABELS, lead.channelState)}</Td>
                  <Td className="text-right text-ink-muted">{formatRelative(lead.updatedAt)}</Td>
                </tr>
              ))}
            </TableShell>
          )}
        </Card>

        <Card title="Capacidades não configuradas" description="O que ainda falta para o sistema operar por completo.">
          {blocked.length === 0 ? (
            <EmptyState title="Tudo configurado" description="Todas as capacidades têm as credenciais e os dados necessários." />
          ) : (
            <ul className="divide-y divide-line">
              {blocked.map((entry) => (
                <li key={entry.id} className="px-4 py-2.5">
                  <p className="text-[12.5px] font-medium text-ink">{CAPABILITY_LABELS[entry.id]}</p>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    Falta: {entry.missing.map((key) => missingLabel(key)).join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
