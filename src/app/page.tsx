import Link from 'next/link';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { alerts, jobs, leads } from '@/db/schema';
import { getBusinessConfig } from '@/config/business';
import { capabilityReport } from '@/features/system/capabilities';
import { costMetrics, funnelCounts, pipelineTotals, ratio, todayStats } from '@/features/analytics/metrics';
import { queueStats } from '@/worker/queue';
import { formatInteger, formatPercent, formatRelative, formatUsd } from '@/lib/format';
import { getEnv, operatingHours } from '@/lib/env';
import { isWithinOperatingHours, nextOperatingSlot, zonedParts } from '@/lib/time';
import { Card, EmptyState, ListRow, Meter, Pill } from './_components/ui';
import { STAGE_LABELS, CAPABILITY_LABELS, labelOr, missingLabel } from './_lib/labels';

export const dynamic = 'force-dynamic';

/** Stages a lead leaves the funnel through, rather than advances into. */
const TERMINAL_STAGES = new Set<string>(['closed']);
/** The stage that means the work paid off. */
const WON_STAGE = 'active_customer';

function clockAt(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export default function DashboardPage() {
  const db = getDb();
  const env = getEnv();
  const config = getBusinessConfig();
  const now = new Date();
  const zone = env.OPERATING_TIMEZONE;

  const customer = pipelineTotals('customer', db);
  const stages = funnelCounts('customer', db);
  const today = todayStats(now, db);
  const cost = costMetrics(db);
  const queue = queueStats(db);
  const capabilities = capabilityReport(db);

  const replyRate = ratio(customer.replied, customer.contacted);
  const handoffRate = ratio(customer.handedOff, customer.replied);

  const hours = operatingHours();
  const openNow = isWithinOperatingHours(now, hours, zone);
  const reopensAt = clockAt(nextOperatingSlot(now, hours, zone), zone);
  const closesAt = minutesToClock(hours.endMinute);

  const paused = capabilities.find((entry) => entry.id === 'global')?.paused ?? false;
  const offline = capabilities.filter((entry) => entry.id !== 'global' && !entry.usable);
  const unconfigured = capabilities.filter((entry) => entry.id !== 'global' && !entry.configured);

  /*
   * Everything the operator personally has to resolve, in one queue: the
   * conversations the AI handed back, then the alerts nobody has closed. Two
   * lists side by side made the reader decide which one was urgent; one list
   * already knows.
   */
  const stuckLeads = db
    .select()
    .from(leads)
    .where(eq(leads.channelState, 'human_review_required'))
    .orderBy(desc(leads.updatedAt))
    .limit(4)
    .all();

  const openAlerts = db.select().from(alerts).where(eq(alerts.status, 'open')).orderBy(desc(alerts.createdAt)).all();

  /*
   * The same failure raised four times is one problem, not four lines. Group by
   * title and carry the count; the alerts page still lists them individually.
   */
  const grouped = new Map<string, { title: string; severity: string; at: string; count: number }>();
  for (const alert of openAlerts) {
    const found = grouped.get(alert.title);
    if (!found) {
      grouped.set(alert.title, { title: alert.title, severity: alert.severity, at: alert.createdAt, count: 1 });
      continue;
    }
    found.count += 1;
    if (alert.severity === 'critical') found.severity = 'critical';
    else if (alert.severity === 'warning' && found.severity === 'info') found.severity = 'warning';
  }
  const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const alertGroups = [...grouped.values()]
    .sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3))
    .slice(0, 4);
  // Problems, not raisings: the badge has to agree with the grouped list below it.
  const pendingCount = stuckLeads.length + grouped.size;

  const nextJob = db
    .select({ scheduledAt: jobs.scheduledAt })
    .from(jobs)
    .where(eq(jobs.status, 'pending'))
    .orderBy(asc(jobs.scheduledAt))
    .limit(1)
    .all()[0];

  const capReached = today.dailyCap > 0 && today.remaining === 0;
  const status = paused
    ? { tone: 'danger' as const, title: 'Operação pausada', detail: 'Nada será enviado até você retomar.' }
    : !openNow
      ? { tone: 'neutral' as const, title: 'Fora do horário', detail: `Volta a abordar às ${reopensAt}.` }
      : capReached
        ? { tone: 'warning' as const, title: 'Limite do dia atingido', detail: 'As abordagens recomeçam amanhã.' }
        : offline.length > 0
          ? {
              tone: 'warning' as const,
              title: 'Operando parcialmente',
              detail:
                offline.length === 1 && offline[0]
                  ? `${CAPABILITY_LABELS[offline[0].id]} está desligado.`
                  : `Desligados: ${offline.map((entry) => CAPABILITY_LABELS[entry.id]).join(', ')}.`,
            }
          : { tone: 'positive' as const, title: 'Operando normalmente', detail: `Abordando até as ${closesAt}.` };

  const dotColor =
    status.tone === 'danger'
      ? 'bg-danger'
      : status.tone === 'warning'
        ? 'bg-warning'
        : status.tone === 'positive'
          ? 'bg-positive'
          : 'bg-ink-faint';

  /*
   * The bars are scaled against the busiest stage of the journey, not against
   * every row. Including "Encerrado" here would size the whole progression
   * against the exit — 7 people abordados would draw as half a bar because 15
   * leads went nowhere, which makes the failure the largest thing on the page.
   */
  const peak = Math.max(1, ...stages.filter((entry) => !TERMINAL_STAGES.has(entry.stage)).map((entry) => entry.count));

  return (
    <>
      {/*
        Is it running? Everything above the fold answers that and nothing else:
        one sentence of state, and the only number that moves during the day.
      */}
      <section className="card overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-6 md:px-6">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="relative mt-[7px] flex size-2.5 shrink-0">
              {status.tone === 'positive' ? (
                <span aria-hidden className={`status-ping absolute inset-0 rounded-full ${dotColor}`} />
              ) : null}
              <span aria-hidden className={`relative size-2.5 rounded-full ${dotColor}`} />
            </span>
            <div className="min-w-0">
              <h1 className="text-[19px] leading-6 font-semibold tracking-[-0.015em] text-ink md:text-[21px] md:leading-7">
                {status.title}
              </h1>
              <p className="mt-1 text-[13px] leading-5 text-ink-muted">{status.detail}</p>
            </div>
          </div>

          <p className="text-[12px] leading-5 text-ink-faint sm:shrink-0 sm:text-right">
            {config.company.name}
            <span className="block">Instagram · {env.OPERATING_HOURS.replace('-', ' às ')}</span>
          </p>
        </div>

        <div className="border-t border-line bg-surface-muted/50 px-5 py-4 md:px-6">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[13px] font-medium text-ink">Mensagens enviadas hoje</p>
            <p className="num text-[13px]">
              <span className="text-[17px] leading-6 font-semibold text-ink">{formatInteger(today.dmsSent)}</span>
              <span className="text-ink-faint"> de {formatInteger(today.dailyCap)}</span>
            </p>
          </div>
          <Meter
            value={today.dmsSent}
            max={today.dailyCap}
            tone={capReached ? 'warning' : 'accent'}
            className="mt-2.5"
            label={`${today.dmsSent} de ${today.dailyCap} mensagens enviadas hoje`}
          />
          <p className="mt-2 text-[12px] leading-4 text-ink-faint">
            {paused
              ? 'A fila fica parada enquanto a operação estiver pausada.'
              : nextJob
                ? `Próxima ação da fila ${formatRelative(nextJob.scheduledAt, now)}.`
                : 'Nenhuma ação agendada na fila neste momento.'}
            {today.inboundToday > 0
              ? ` ${formatInteger(today.inboundToday)} ${
                  today.inboundToday === 1 ? 'resposta recebida' : 'respostas recebidas'
                } nas últimas 24 h.`
              : ''}
          </p>
        </div>
      </section>

      {/*
        What needs me? Conversations the AI handed back come first — those are
        leads waiting on a person — then the alerts nobody has closed.
      */}
      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-5">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink">Precisa de você</h2>
            <p className="mt-0.5 text-[12px] leading-4 text-ink-faint">
              O que a operação não resolve sozinha e está esperando uma decisão.
            </p>
          </div>
          {pendingCount > 0 ? (
            <span className="num shrink-0 rounded-full bg-warning-soft px-2.5 py-1 text-[12px] font-semibold text-warning">
              {formatInteger(pendingCount)}
            </span>
          ) : null}
        </div>

        {pendingCount === 0 ? (
          <EmptyState
            title="Tudo em dia"
            description="Nenhuma conversa parada e nenhum alerta aberto. A operação segue sozinha."
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {stuckLeads.map((lead) => (
                <li key={lead.id}>
                  <ListRow
                    href={`/leads/${lead.id}`}
                    leading={<Pill tone="accent">Lead</Pill>}
                    title={`@${lead.handle}`}
                    meta={`${labelOr(STAGE_LABELS, lead.pipelineStage)} · a IA pediu ajuda para continuar`}
                    trailing={formatRelative(lead.updatedAt, now)}
                  />
                </li>
              ))}
              {alertGroups.map((alert) => (
                <li key={alert.title}>
                  <ListRow
                    href="/alertas"
                    leading={
                      <Pill
                        tone={
                          alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'neutral'
                        }
                      >
                        {alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Aviso'}
                      </Pill>
                    }
                    title={alert.title}
                    meta={alert.count > 1 ? `Aconteceu ${alert.count} vezes` : 'Aconteceu uma vez'}
                    trailing={formatRelative(alert.at, now)}
                  />
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-4 py-2 md:px-5">
              <Link
                href="/alertas"
                className="inline-flex min-h-11 items-center text-[12.5px] font-medium text-accent-ink hover:underline md:min-h-0"
              >
                {openAlerts.length > alertGroups.length
                  ? `Ver os ${formatInteger(openAlerts.length)} alertas abertos`
                  : 'Ver alertas e exceções'}
              </Link>
            </div>
          </>
        )}
      </section>

      {/* The result, once the state above is settled. */}
      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card title="Onde estão os leads" description="Etapa atual de cada lead no funil de clientes.">
          {customer.discovered === 0 ? (
            <EmptyState
              title="Nenhum lead ainda"
              description="Importe uma lista de perfis ou ligue a descoberta automática para o sistema começar a trabalhar."
              action={
                <Link
                  href="/clientes"
                  className="inline-flex min-h-11 items-center rounded-md bg-accent px-3.5 text-[12.5px] font-medium text-white hover:opacity-90"
                >
                  Abrir funil de clientes
                </Link>
              }
            />
          ) : (
            <ul className="px-4 py-2 md:px-5 md:py-3">
              {stages.map((entry) => {
                const terminal = TERMINAL_STAGES.has(entry.stage);
                const tone = terminal ? 'neutral' : entry.stage === WON_STAGE ? 'positive' : 'accent';
                return (
                  /*
                   * Grid, not a wrapping flex row: a flex child at `w-full`
                   * makes its own width depend on the row it is sizing, and
                   * Chrome resolves that by letting the card run 32px past the
                   * screen. An explicit `minmax(0, 1fr)` track cannot.
                   */
                  <li
                    key={entry.stage}
                    className={`grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-3 gap-y-1.5 py-2 md:flex md:gap-x-4 ${
                      terminal ? 'mt-1 border-t border-line pt-3' : ''
                    }`}
                  >
                    <span
                      className={`col-span-2 min-w-0 truncate text-[12.5px] md:col-span-1 md:w-48 md:shrink-0 ${
                        terminal ? 'text-ink-muted' : entry.count > 0 ? 'text-ink' : 'text-ink-faint'
                      }`}
                    >
                      {STAGE_LABELS[entry.stage]}
                    </span>
                    {terminal ? (
                      // No bar: a leaving stage has nothing to be a share of, and
                      // drawn on the same scale it reads as the tallest achievement.
                      <span className="min-w-0 md:flex-1" />
                    ) : (
                      <Meter
                        value={entry.count}
                        max={peak}
                        tone={tone}
                        className={`min-w-0 md:flex-1 ${entry.count === 0 ? 'opacity-45' : ''}`}
                      />
                    )}
                    <span
                      className={`num w-9 shrink-0 text-right text-[12.5px] font-medium ${
                        terminal ? 'text-ink-muted' : entry.count > 0 ? 'text-ink' : 'text-ink-faint'
                      }`}
                    >
                      {formatInteger(entry.count)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Resultado até agora" description="Somando todos os leads que já passaram por cada etapa.">
            <dl className="divide-y divide-line">
              {[
                {
                  label: 'Responderam a abordagem',
                  value: replyRate === null ? '—' : formatPercent(replyRate, 1),
                  hint:
                    replyRate === null
                      ? 'Ninguém foi abordado ainda'
                      : `${formatInteger(customer.replied)} de ${formatInteger(customer.contacted)} abordados`,
                  danger: false,
                },
                {
                  label: 'Levados ao WhatsApp',
                  value: formatInteger(customer.handedOff),
                  hint:
                    handoffRate === null ? 'Ninguém respondeu ainda' : `${formatPercent(handoffRate, 1)} de quem respondeu`,
                  danger: false,
                },
                {
                  label: 'Gasto com IA no mês',
                  value: cost.hasUnpricedCalls && cost.spentUsd === 0 ? '—' : formatUsd(cost.spentUsd),
                  hint: cost.hasUnpricedCalls
                    ? 'Falta informar o preço por token no .env'
                    : `De um orçamento de ${formatUsd(cost.budgetUsd)}`,
                  danger: cost.exceeded,
                },
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4 px-4 py-3 md:px-5">
                  <div className="min-w-0">
                    <dt className="text-[12.5px] leading-5 text-ink">{row.label}</dt>
                    <dd className="mt-0.5 text-[11.5px] leading-4 text-ink-faint">{row.hint}</dd>
                  </div>
                  <dd
                    className={`num shrink-0 text-[19px] leading-6 font-semibold ${row.danger ? 'text-danger' : 'text-ink'}`}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title="Fila de trabalho" description="O que o sistema tem para executar.">
            <dl className="grid grid-cols-3 divide-x divide-line">
              {[
                { label: 'Aguardando', value: queue.pending, warn: false },
                { label: 'Em execução', value: queue.running, warn: false },
                { label: 'Desistiram', value: queue.dead, warn: true },
              ].map((entry) => (
                <div key={entry.label} className="px-4 py-3">
                  <dt className="text-[11px] leading-4 tracking-wide text-ink-faint uppercase">{entry.label}</dt>
                  <dd
                    className={`num mt-1 text-[19px] leading-6 font-semibold ${
                      entry.warn && entry.value > 0 ? 'text-warning' : 'text-ink'
                    }`}
                  >
                    {formatInteger(entry.value)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="border-t border-line px-4 py-2">
              <Link
                href="/jobs"
                className="inline-flex min-h-11 items-center text-[12.5px] font-medium text-accent-ink hover:underline md:min-h-0"
              >
                Ver fila completa
              </Link>
            </div>
          </Card>

          {unconfigured.length > 0 ? (
            <Card title="Falta configurar" description="Recursos desligados por falta de informação.">
              <ul className="divide-y divide-line">
                {unconfigured.map((entry) => (
                  <li key={entry.id} className="px-4 py-3 md:px-5">
                    <p className="text-[12.5px] leading-5 font-medium text-ink">{CAPABILITY_LABELS[entry.id]}</p>
                    <ul className="mt-1 space-y-0.5">
                      {entry.missing.map((key) => (
                        <li key={key} className="text-[12px] leading-4 text-ink-muted">
                          {missingLabel(key)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-4 py-2">
                <Link
                  href="/configuracoes"
                  className="inline-flex min-h-11 items-center text-[12.5px] font-medium text-accent-ink hover:underline md:min-h-0"
                >
                  Abrir configurações
                </Link>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
