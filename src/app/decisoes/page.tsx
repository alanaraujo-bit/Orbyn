import Link from 'next/link';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { auditLog, events } from '@/db/schema';
import { formatDateTime } from '@/lib/format';
import { Card, EmptyState, PageHeader, Pill, TableShell, Td, Th } from '../_components/ui';
import { ACTOR_LABELS, GENERATOR_LABELS, INTENT_LABELS, labelOr } from '../_lib/labels';

export const dynamic = 'force-dynamic';

interface InterpretationPayload {
  intent?: string;
  generator?: string;
  confidence?: number;
}

export default function DecisionsPage() {
  const db = getDb();

  const interpretations = db
    .select()
    .from(events)
    .where(eq(events.type, 'inbound.interpreted'))
    .orderBy(desc(events.occurredAt))
    .limit(60)
    .all();

  const aiActions = db
    .select()
    .from(auditLog)
    .where(inArray(auditLog.actor, ['ai', 'worker', 'system']))
    .orderBy(desc(auditLog.createdAt))
    .limit(80)
    .all();

  return (
    <>
      <PageHeader
        title="Decisões da IA"
        description="Como cada resposta foi interpretada e o que o sistema decidiu em seguida. Tudo auditável, com o autor da decisão registrado."
      />

      <Card title="Interpretação de respostas" className="mb-4">
        {interpretations.length === 0 ? (
          <EmptyState
            title="Nenhuma resposta interpretada"
            description="As interpretações aparecem aqui assim que os leads começarem a responder."
          />
        ) : (
          <TableShell
            head={
              <>
                <Th role="meta">Quando</Th>
                <Th role="title">Lead</Th>
                <Th role="badge">Intenção</Th>
                <Th>Origem</Th>
                <Th className="text-right">Confiança</Th>
              </>
            }
          >
            {interpretations.map((event) => {
              let payload: InterpretationPayload = {};
              try {
                payload = JSON.parse(event.payload) as InterpretationPayload;
              } catch {
                payload = {};
              }
              return (
                <tr key={event.id}>
                  <Td className="whitespace-nowrap text-ink-muted">{formatDateTime(event.occurredAt)}</Td>
                  <Td>
                    {event.leadId ? (
                      <Link href={`/leads/${event.leadId}`} className="inline-flex min-h-11 items-center md:min-h-0 text-accent-ink hover:underline">
                        ver lead
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    <Pill tone={payload.intent === 'opt_out' ? 'danger' : 'accent'}>
                      {labelOr(INTENT_LABELS, payload.intent ?? '—')}
                    </Pill>
                  </Td>
                  <Td className="text-ink-muted">{labelOr(GENERATOR_LABELS, payload.generator ?? '—')}</Td>
                  <Td className="num text-right">
                    {typeof payload.confidence === 'number' ? payload.confidence.toFixed(2) : '—'}
                  </Td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </Card>

      <Card title="Trilha de auditoria" description="Mudanças de estado, pausas, ajustes de estratégia e escalonamentos.">
        {aiActions.length === 0 ? (
          <EmptyState title="Sem registros" description="Nenhuma decisão automática registrada até agora." />
        ) : (
          <TableShell
            head={
              <>
                <Th role="meta">Quando</Th>
                <Th>Autor</Th>
                <Th role="title">Ação</Th>
                <Th>Entidade</Th>
                <Th>Motivo</Th>
              </>
            }
          >
            {aiActions.map((entry) => (
              <tr key={entry.id}>
                <Td className="whitespace-nowrap text-ink-muted">{formatDateTime(entry.createdAt)}</Td>
                <Td>{labelOr(ACTOR_LABELS, entry.actor)}</Td>
                <Td className="font-mono text-[11.5px]">{entry.action}</Td>
                <Td className="text-ink-muted">
                  {entry.entityType}
                  {entry.entityId ? ` · ${entry.entityId.slice(0, 12)}` : ''}
                </Td>
                <Td className="max-w-[320px] text-ink-muted">{entry.reason ?? '—'}</Td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>
    </>
  );
}
