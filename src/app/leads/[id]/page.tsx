import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { auditLog, events, experimentVariants, leads } from '@/db/schema';
import { getBusinessConfig, outboundLink } from '@/config/business';
import { profileUrl } from '@/features/leads/handle';
import { leadTagList } from '@/features/leads/repository';
import { findConversationByLead, listMessages } from '@/features/conversations/repository';
import { evaluateSendGuard } from '@/features/conversations/channel';
import type { ScoreSignal } from '@/features/leads/scoring';
import type { ChannelState, PipelineStage } from '@/features/leads/states';
import { formatDateTime, formatInteger, formatRelative } from '@/lib/format';
import { Card, Field, PageHeader, Pill, Td, TableShell, Th, EmptyState, type Tone } from '@/app/_components/ui';
import { ActionButton } from '@/app/_components/action-button';
import {
  ACTOR_LABELS,
  CHANNEL_OWNER_LABELS,
  CHANNEL_STATE_LABELS,
  GENERATOR_LABELS,
  INTENT_LABELS,
  PERSONA_LABELS,
  STAGE_LABELS,
  labelOr,
} from '@/app/_lib/labels';
import { markDoNotContactAction, scheduleFirstContactAction } from '@/app/_actions/operations';
import { StageSelector } from './stage-selector';

export const dynamic = 'force-dynamic';

interface ScoreBreakdown {
  signals?: ScoreSignal[];
  matchedKeywords?: string[];
}

interface Snapshot {
  postHashtags?: string[];
  postCaptions?: string[];
  provenance?: Record<string, string>;
  observedAt?: string;
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const CHANNEL_TONE: Record<string, Tone> = {
  api_eligible: 'positive',
  api_active: 'positive',
  api_window_closed: 'warning',
  human_review_required: 'warning',
  do_not_contact: 'danger',
  blocked: 'danger',
};

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const lead = db.select().from(leads).where(eq(leads.id, id)).get();
  if (!lead) notFound();

  const config = getBusinessConfig();
  const conversation = findConversationByLead(lead.id, db);
  const messages = conversation ? listMessages(conversation.id, db) : [];
  const tags = leadTagList(lead.id, db);
  const breakdown = parse<ScoreBreakdown>(lead.scoreBreakdown, {});
  const snapshot = parse<Snapshot>(lead.profileSnapshot, {});
  const whatsapp = outboundLink('whatsapp', config);

  const timeline = db
    .select()
    .from(events)
    .where(eq(events.leadId, lead.id))
    .orderBy(desc(events.occurredAt))
    .limit(40)
    .all();

  const decisions = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, lead.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(20)
    .all();

  const variants = db.select().from(experimentVariants).all();
  const guard = conversation
    ? evaluateSendGuard({ lead, conversation, channel: conversation.channelOwner === 'api' ? 'api' : 'browser' })
    : null;

  return (
    <>
      <PageHeader
        title={`@${lead.handle}`}
        description={lead.displayName ?? undefined}
        actions={
          <>
            <a
              href={profileUrl(lead.handle)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center rounded-md border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-muted md:min-h-0"
            >
              Abrir no Instagram
            </a>
            {whatsapp ? (
              <a
                href={whatsapp}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-11 items-center rounded-md border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-muted md:min-h-0"
              >
                WhatsApp oficial
              </a>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Pill tone="accent">{labelOr(STAGE_LABELS, lead.pipelineStage)}</Pill>
        <Pill tone={CHANNEL_TONE[lead.channelState] ?? 'neutral'}>
          {labelOr(CHANNEL_STATE_LABELS, lead.channelState)}
        </Pill>
        <Pill>Canal: {labelOr(CHANNEL_OWNER_LABELS, lead.channelOwner)}</Pill>
        <Pill tone={lead.icpScore >= 70 ? 'positive' : lead.icpScore >= 40 ? 'accent' : 'neutral'}>
          ICP {Math.round(lead.icpScore)}
        </Pill>
        {lead.doNotContact === 1 ? <Pill tone="danger">Não contatar</Pill> : null}
        {tags.map((tag) => (
          <Pill key={tag}>{tag}</Pill>
        ))}
      </div>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1.35fr_1fr] lg:gap-4">
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <Card title="Conversa" description="Tudo que foi enviado e recebido nesta thread." className="order-2 lg:order-none">
            {messages.length === 0 ? (
              <EmptyState
                title="Nenhuma mensagem ainda"
                description="A primeira DM será enviada pelo navegador quando o lead entrar na fila de abordagem."
              />
            ) : (
              <ol className="flex flex-col gap-3 px-4 py-4">
                {messages.map((message) => {
                  const meta = parse<{ generator?: string; observationUsed?: string | null; variant?: string | null }>(
                    message.meta,
                    {},
                  );
                  const outbound = message.direction === 'outbound';
                  return (
                    <li key={message.id} className={outbound ? 'flex justify-end' : 'flex justify-start'}>
                      <div
                        className={`max-w-[88%] rounded-lg border px-3 py-2 md:max-w-[80%] ${
                          outbound ? 'border-accent-soft bg-accent-soft' : 'border-line bg-surface-muted'
                        }`}
                      >
                        <p className="text-[13px] leading-5 whitespace-pre-wrap text-ink">{message.body}</p>
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint">
                          <span>{outbound ? 'Enviada' : 'Recebida'}</span>
                          <span>·</span>
                          <span>{message.channel === 'browser' ? 'Navegador' : message.channel === 'api' ? 'API oficial' : 'Sistema'}</span>
                          <span>·</span>
                          <span>{formatDateTime(message.sentAt ?? message.createdAt)}</span>
                          {meta.generator ? (
                            <>
                              <span>·</span>
                              <span>{labelOr(GENERATOR_LABELS, meta.generator)}</span>
                            </>
                          ) : null}
                          {meta.variant ? (
                            <>
                              <span>·</span>
                              <span>variante {meta.variant}</span>
                            </>
                          ) : null}
                          {message.intent ? (
                            <>
                              <span>·</span>
                              <span>{labelOr(INTENT_LABELS, message.intent)}</span>
                            </>
                          ) : null}
                        </p>
                        {meta.observationUsed ? (
                          <p className="mt-1 text-[11px] text-ink-faint">
                            Observação usada: “{meta.observationUsed}”
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <Card title="Linha do tempo" description="Eventos registrados para este lead." className="order-5 lg:order-none">
            {timeline.length === 0 ? (
              <EmptyState title="Sem eventos" description="Nada registrado para este lead ainda." />
            ) : (
              <ol className="divide-y divide-line">
                {timeline.map((event) => (
                  <li key={event.id} className="flex flex-col gap-0.5 px-4 py-2 md:flex-row md:items-baseline md:gap-3">
                    <span className="text-[11.5px] text-ink-faint md:w-40 md:shrink-0">{formatDateTime(event.occurredAt)}</span>
                    <span className="font-mono text-[11.5px] text-ink">{event.type}</span>
                    <span className="truncate text-[11.5px] text-ink-muted">{event.payload}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <Card title="Ações do operador" className="order-1 lg:order-none">
            <div className="flex flex-col gap-3 px-4 py-3">
              {lead.doNotContact === 1 ? (
                <p className="text-[12.5px] text-ink-muted">
                  Este lead está em não contatar. Nenhuma abordagem, follow-up ou reentrada em campanha ocorrerá.
                </p>
              ) : (
                <>
                  <ActionButton
                    block
                    variant="primary"
                    action={scheduleFirstContactAction.bind(null, lead.id)}
                    disabled={lead.channelState !== 'browser_contact_pending'}
                    title={
                      lead.channelState !== 'browser_contact_pending'
                        ? 'Disponível apenas enquanto o lead aguarda o primeiro contato'
                        : undefined
                    }
                  >
                    Enfileirar primeiro contato
                  </ActionButton>
                  <StageSelector leadId={lead.id} funnel={lead.funnel} current={lead.pipelineStage as PipelineStage} />
                  <ActionButton
                    block
                    variant="danger"
                    confirm="Isto impede qualquer contato futuro."
                    action={markDoNotContactAction.bind(null, lead.id, 'operator_block')}
                  >
                    Marcar como não contatar
                  </ActionButton>
                </>
              )}
              {guard && !guard.allowed ? (
                <p className="rounded-md border border-line bg-surface-muted px-2.5 py-2 text-[12px] text-ink-muted">
                  Envio automático bloqueado: {guard.reason}
                </p>
              ) : null}
            </div>
          </Card>

          <Card title="Perfil público observado" description="Somente o que foi coletado das páginas públicas." className="order-3 lg:order-none">
            <dl className="divide-y divide-line px-4 py-1">
              <Field label="Bio">{lead.bio ?? '—'}</Field>
              <Field label="Categoria">{lead.category ?? '—'}</Field>
              <Field label="Localização">{lead.location ?? '—'}</Field>
              <Field label="Site">{lead.externalUrl ?? '—'}</Field>
              <Field label="Seguidores">
                {lead.followersCount === null ? '—' : formatInteger(lead.followersCount)}
              </Field>
              <Field label="Interlocutor">{labelOr(PERSONA_LABELS, lead.persona)}</Field>
              <Field label="Nicho">{lead.niche ?? '—'}</Field>
              <Field label="Hashtags observadas">
                {(snapshot.postHashtags ?? []).length > 0 ? (snapshot.postHashtags ?? []).join(', ') : '—'}
              </Field>
              <Field label="Origem">
                {lead.discoverySource}
                {lead.sourceKeyword ? ` · ${lead.sourceKeyword}` : ''}
              </Field>
              <Field label="Coletado em">{formatDateTime(snapshot.observedAt ?? lead.createdAt)}</Field>
              <Field label="Retenção até">{formatDateTime(lead.retentionExpiresAt)}</Field>
            </dl>
          </Card>

          <Card
            title="Aderência ao ICP"
            description={`Pontuação ${Math.round(lead.icpScore)} de 100.`}
            className="order-4 lg:order-none"
          >
            {(breakdown.signals ?? []).length === 0 ? (
              <EmptyState title="Sem sinais registrados" description="Nenhum sinal do ICP foi identificado neste perfil." />
            ) : (
              <ul className="divide-y divide-line">
                {(breakdown.signals ?? []).map((signal) => (
                  <li key={signal.key} className="flex items-start justify-between gap-3 px-4 py-2">
                    <div className="min-w-0">
                      <p className="text-[12.5px] text-ink">{signal.label}</p>
                      <p className="truncate text-[11.5px] text-ink-faint">{signal.matched.join(', ')}</p>
                    </div>
                    <span className="num shrink-0 text-[12.5px] font-medium text-ink">
                      {signal.weight > 0 ? '+' : ''}
                      {Math.round(signal.weight)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Decisões registradas" description="Quem mudou o quê, e por quê." className="order-6 lg:order-none">
            {decisions.length === 0 ? (
              <EmptyState title="Sem decisões" description="Nenhuma decisão registrada para este lead." />
            ) : (
              <TableShell
                head={
                  <>
                    <Th role="meta">Quando</Th>
                    <Th>Autor</Th>
                    <Th role="title">Ação</Th>
                  </>
                }
              >
                {decisions.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="whitespace-nowrap text-ink-muted">{formatRelative(entry.createdAt)}</Td>
                    <Td>{labelOr(ACTOR_LABELS, entry.actor)}</Td>
                    <Td>
                      <span className="font-mono text-[11.5px]">{entry.action}</span>
                      {entry.reason ? <p className="text-[11.5px] text-ink-faint">{entry.reason}</p> : null}
                    </Td>
                  </tr>
                ))}
              </TableShell>
            )}
          </Card>
        </div>
      </div>

      <p className="mt-6 text-[12px] text-ink-faint">
        Canal atual: {labelOr(CHANNEL_STATE_LABELS, lead.channelState as ChannelState)}
        {conversation?.apiWindowExpiresAt ? ` · janela da API até ${formatDateTime(conversation.apiWindowExpiresAt)}` : ''}
        {variants.length > 0 ? ` · ${variants.length} variantes cadastradas` : ''} ·{' '}
        <Link
          href={lead.funnel === 'customer' ? '/clientes' : '/afiliados'}
          className="inline-flex min-h-11 items-center text-accent-ink hover:underline md:min-h-0"
        >
          voltar ao funil
        </Link>
      </p>
    </>
  );
}
