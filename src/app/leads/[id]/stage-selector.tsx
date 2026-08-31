'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { moveStageAction } from '@/app/_actions/operations';
import { AFFILIATE_STAGES, CUSTOMER_STAGES, canTransitionStage, type Funnel, type PipelineStage } from '@/features/leads/states';
import { STAGE_LABELS } from '@/app/_lib/labels';

/**
 * Manual stage change. Only transitions the state machine actually allows are
 * offered, so the operator cannot put a lead into an impossible state.
 */
export function StageSelector({ leadId, funnel, current }: { leadId: string; funnel: string; current: PipelineStage }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const stages = (funnel === 'customer' ? CUSTOMER_STAGES : AFFILIATE_STAGES) as readonly PipelineStage[];
  const options = stages.filter((stage) => canTransitionStage(funnel as Funnel, current, stage));

  if (options.length === 0) {
    return <p className="text-[12px] text-ink-faint">Etapa final: não há transição manual disponível.</p>;
  }

  const change = (stage: string): void => {
    if (stage === '') return;
    setError(null);
    startTransition(async () => {
      const result = await moveStageAction(leadId, stage);
      if (result.ok) router.refresh();
      else setError(result.message);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="stage" className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">
        Avançar etapa
      </label>
      <select
        id="stage"
        defaultValue=""
        disabled={pending}
        onChange={(event) => change(event.target.value)}
        className="min-h-11 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink disabled:opacity-60 md:min-h-0 md:w-auto"
      >
        <option value="">{pending ? 'Atualizando…' : 'Selecione a nova etapa'}</option>
        {options.map((stage) => (
          <option key={stage} value={stage}>
            {STAGE_LABELS[stage]}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
