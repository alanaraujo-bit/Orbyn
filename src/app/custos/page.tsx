import { getDb } from '@/db/client';
import { costMetrics, pipelineTotals } from '@/features/analytics/metrics';
import { recentAiCalls } from '@/integrations/openai/usage';
import { capabilityReport } from '@/features/system/capabilities';
import { formatDateTime, formatInteger, formatUsd, formatUsdPrecise } from '@/lib/format';
import { Card, EmptyState, PageHeader, Pill, Stat, TableShell, Td, Th } from '../_components/ui';

export const dynamic = 'force-dynamic';

function costOrDash(value: number | null, pricesConfigured: boolean): string {
  if (!pricesConfigured) return 'preço não configurado';
  if (value === null) return '—';
  return formatUsdPrecise(value);
}

export default function CostsPage() {
  const db = getDb();
  const cost = costMetrics(db);
  const totals = pipelineTotals('customer', db);
  const calls = recentAiCalls(60, db);
  const aiCapability = capabilityReport(db).find((entry) => entry.id === 'ai_engine');
  const priced = cost.pricesConfigured;

  const rows: { label: string; value: number | null; denominator: number; denominatorLabel: string }[] = [
    { label: 'Por lead descoberto', value: cost.perDiscoveredLead, denominator: totals.discovered, denominatorLabel: 'leads descobertos' },
    { label: 'Por lead abordado', value: cost.perContactedLead, denominator: totals.contacted, denominatorLabel: 'leads abordados' },
    { label: 'Por resposta', value: cost.perReply, denominator: totals.replied, denominatorLabel: 'respostas' },
    { label: 'Por oportunidade', value: cost.perOpportunity, denominator: totals.handedOff, denominatorLabel: 'encaminhamentos' },
    { label: 'Por cliente ativo', value: cost.perActiveCustomer, denominator: totals.activeCustomers, denominatorLabel: 'clientes ativos' },
  ];

  return (
    <>
      <PageHeader
        title="Custo de IA"
        description="Toda chamada ao modelo é registrada com tokens, operação e resultado. Métricas derivadas só aparecem quando existe denominador real."
      />

      {!aiCapability?.configured ? (
        <Card className="mb-4">
          <div className="px-4 py-3">
            <p className="text-[12.5px] text-ink">
              O motor de IA está desativado porque <code>OPENAI_API_KEY</code> não está configurada. A prospecção segue
              funcionando com aberturas determinísticas e classificação por regras; respostas que exigiriam a IA são
              encaminhadas para revisão humana.
            </p>
          </div>
        </Card>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Gasto no mês"
          value={!priced && cost.spentUsd === 0 ? '—' : formatUsdPrecise(cost.spentUsd)}
          hint={priced ? `Teto: ${formatUsd(cost.budgetUsd)}` : 'Preço por token não informado no .env'}
          tone={cost.exceeded ? 'danger' : 'neutral'}
        />
        <Stat label="Restante" value={priced ? formatUsd(cost.remainingUsd) : '—'} />
        <Stat label="Chamadas no mês" value={formatInteger(cost.callCount)} />
        <Stat
          label="Status do orçamento"
          value={cost.exceeded ? 'Bloqueado' : 'Dentro do teto'}
          tone={cost.exceeded ? 'danger' : 'positive'}
          hint={cost.exceeded ? 'Novas chamadas estão bloqueadas' : undefined}
        />
      </div>

      {priced && cost.hasUnpricedCalls ? (
        <p className="mb-4 text-[12px] text-ink-muted">
          Algumas chamadas deste mês foram registradas antes de os preços serem configurados e permanecem com custo zero.
          O total acima considera apenas o que pôde ser calculado.
        </p>
      ) : null}

      {cost.cachedInputTokens > 0 ? (
        <p className="mb-4 text-[12px] text-ink-muted">
          {formatInteger(cost.cachedInputTokens)} tokens de entrada foram servidos pelo cache de prompt e cobrados pela
          tarifa reduzida.
        </p>
      ) : null}

      <Card title="Custo por resultado" description="Somente denominadores que existem de fato." className="mb-4">
        <TableShell
          head={
            <>
              <Th role="title">Métrica</Th>
              <Th role="meta">Denominador</Th>
              <Th className="text-right">Custo</Th>
            </>
          }
        >
          {rows.map((row) => (
            <tr key={row.label}>
              <Td>{row.label}</Td>
              <Td className="num text-ink-muted">
                {row.denominator === 0 ? `sem ${row.denominatorLabel}` : `${formatInteger(row.denominator)} ${row.denominatorLabel}`}
              </Td>
              <Td className="num text-right">{costOrDash(row.value, priced)}</Td>
            </tr>
          ))}
        </TableShell>
      </Card>

      <Card title="Chamadas recentes">
        {calls.length === 0 ? (
          <EmptyState
            title="Nenhuma chamada registrada"
            description="Assim que o motor de IA for usado, cada chamada aparecerá aqui com tokens e custo."
          />
        ) : (
          <TableShell
            head={
              <>
                <Th role="meta">Quando</Th>
                <Th role="title">Operação</Th>
                <Th>Modelo</Th>
                <Th>Tokens (entrada / cache / saída)</Th>
                <Th role="badge">Status</Th>
                <Th className="text-right">Custo</Th>
              </>
            }
          >
            {calls.map((call) => (
              <tr key={call.id}>
                <Td className="whitespace-nowrap text-ink-muted">{formatDateTime(call.createdAt)}</Td>
                <Td className="font-mono text-[11.5px]">{call.operation}</Td>
                <Td className="font-mono text-[11.5px] text-ink-muted">{call.model}</Td>
                <Td className="num" title="entrada total / servidos pelo cache / saída">
                  {formatInteger(call.inputTokens)} / {formatInteger(call.cachedInputTokens)} /{' '}
                  {formatInteger(call.outputTokens)}
                </Td>
                <Td>
                  <Pill tone={call.status === 'succeeded' ? 'positive' : call.status === 'blocked' ? 'warning' : 'danger'}>
                    {call.status === 'succeeded' ? 'OK' : call.status === 'blocked' ? 'Bloqueada' : 'Falhou'}
                  </Pill>
                </Td>
                <Td className="num text-right">{call.costUsd === 0 ? '—' : formatUsdPrecise(call.costUsd)}</Td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>
    </>
  );
}
