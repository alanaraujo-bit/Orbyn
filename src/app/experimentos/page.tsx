import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { experiments } from '@/db/schema';
import { analyzeExperiment } from '@/features/experiments/analysis';
import { listStrategy } from '@/features/experiments/strategy-store';
import { formatDateTime, formatInteger, formatPercent } from '@/lib/format';
import { Card, EmptyState, PageHeader, Pill, TableShell, Td, Th } from '../_components/ui';
import { STAGE_LABELS, labelOr } from '../_lib/labels';

export const dynamic = 'force-dynamic';

const VERDICT_LABELS: Record<string, string> = {
  insufficient_sample: 'Amostra insuficiente',
  no_significant_difference: 'Sem diferença significativa',
  winner: 'Variante vencedora',
};

export default function ExperimentsPage() {
  const db = getDb();
  const rows = db.select().from(experiments).orderBy(desc(experiments.createdAt)).all();
  const strategy = listStrategy(db);

  return (
    <>
      <PageHeader
        title="Experimentos"
        description="Uma variável por vez, amostra registrada e vencedor declarado apenas com confiança suficiente. A exposição muda gradualmente e sempre sobra espaço para exploração."
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nenhum experimento cadastrado"
            description="O experimento padrão de abertura é criado automaticamente quando o worker ou o painel sobem."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((experiment) => {
            const analysis = analyzeExperiment(experiment.id, db);
            const running = experiment.status === 'running';
            return (
              <Card
                key={experiment.id}
                title={experiment.name}
                description={experiment.hypothesis}
                actions={
                  <div className="flex items-center gap-2">
                    <Pill tone={running ? 'positive' : 'neutral'}>{running ? 'Em execução' : experiment.status}</Pill>
                    <Pill tone={analysis?.verdict === 'winner' ? 'accent' : 'neutral'}>
                      {VERDICT_LABELS[analysis?.verdict ?? 'insufficient_sample']}
                    </Pill>
                  </div>
                }
              >
                <div className="grid grid-cols-1 gap-3 border-b border-line px-4 py-3 text-[12.5px] sm:grid-cols-4">
                  <div>
                    <p className="text-[11px] tracking-wide text-ink-faint uppercase">Métrica principal</p>
                    <p className="mt-0.5 text-ink">{labelOr(STAGE_LABELS, experiment.primaryMetric)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] tracking-wide text-ink-faint uppercase">Amostra</p>
                    <p className="num mt-0.5 text-ink">
                      {formatInteger(analysis?.totalAssigned ?? 0)} / {formatInteger(experiment.minSampleSize)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] tracking-wide text-ink-faint uppercase">Janela de análise</p>
                    <p className="mt-0.5 text-ink">{experiment.analysisWindowDays} dias</p>
                  </div>
                  <div>
                    <p className="text-[11px] tracking-wide text-ink-faint uppercase">Início</p>
                    <p className="mt-0.5 text-ink">{formatDateTime(experiment.startedAt)}</p>
                  </div>
                </div>

                <TableShell
                  head={
                    <>
                      <Th>Variante</Th>
                      <Th>Exposição</Th>
                      <Th>Atribuídos</Th>
                      <Th>Sucessos</Th>
                      <Th className="text-right">Taxa</Th>
                    </>
                  }
                >
                  {(analysis?.variants ?? []).map((variant) => (
                    <tr key={variant.variantId} className={variant.variantId === analysis?.winnerVariantId ? 'bg-positive-soft/40' : ''}>
                      <Td>
                        <span className="font-medium text-ink">{variant.variantName}</span>
                        {variant.isControl ? <span className="ml-2 text-[11px] text-ink-faint">controle</span> : null}
                      </Td>
                      <Td className="num">{formatPercent(variant.weight, 0)}</Td>
                      <Td className="num">{formatInteger(variant.assigned)}</Td>
                      <Td className="num">{formatInteger(variant.successes)}</Td>
                      <Td className="num text-right">
                        {variant.assigned === 0 ? '—' : formatPercent(variant.rate, 1)}
                      </Td>
                    </tr>
                  ))}
                </TableShell>

                {analysis?.verdict === 'insufficient_sample' ? (
                  <p className="border-t border-line px-4 py-2 text-[12px] text-ink-muted">
                    Nenhum vencedor será declarado antes de {formatInteger(experiment.minSampleSize)} atribuições.
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <Card
        title="Estratégia aprendida"
        description="Inteligência operacional que o sistema pode evoluir sozinho. Separada dos fatos oficiais do negócio."
        className="mt-4"
      >
        {strategy.length === 0 ? (
          <EmptyState title="Nada aprendido ainda" description="Os ajustes do otimizador aparecem aqui." />
        ) : (
          <TableShell
            head={
              <>
                <Th role="title">Chave</Th>
                <Th>Valor</Th>
                <Th>Autor</Th>
                <Th role="meta" className="text-right">Atualizado</Th>
              </>
            }
          >
            {strategy.map((row) => (
              <tr key={row.key}>
                <Td className="font-mono text-[11.5px]">{row.key}</Td>
                <Td className="max-w-[420px] font-mono text-[11.5px] text-ink-muted">{row.value}</Td>
                <Td>{row.updatedBy}</Td>
                <Td className="text-right whitespace-nowrap text-ink-muted">{formatDateTime(row.updatedAt)}</Td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>
    </>
  );
}
