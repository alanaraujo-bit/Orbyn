'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { pauseCapabilityAction, resumeCapabilityAction } from '@/app/_actions/operations';

/**
 * Master switch. Pausing is instant and needs no confirmation - it is the safe
 * direction. Resuming asks, because it puts outbound messaging back on.
 */
export function GlobalPause({ paused }: { paused: boolean }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  const toggle = (): void => {
    startTransition(async () => {
      if (paused) {
        await resumeCapabilityAction('global');
      } else {
        await pauseCapabilityAction('global', 'Pausa geral acionada pelo operador');
      }
      setConfirming(false);
      router.refresh();
    });
  };

  if (paused && confirming) {
    return (
      <div className="rounded-md border border-line bg-surface-muted p-2">
        <p className="text-[12px] text-ink-muted">Retomar a operação?</p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={toggle}
            disabled={pending}
            className="min-h-11 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-60 md:min-h-0"
          >
            {pending ? 'Retomando…' : 'Retomar'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="min-h-11 rounded-md px-3 py-1 text-[12px] text-ink-muted hover:text-ink md:min-h-0"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => (paused ? setConfirming(true) : toggle())}
      disabled={pending}
      aria-pressed={paused}
      className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-60 md:min-h-0 ${
        paused
          ? 'border-danger/30 bg-danger-soft text-danger'
          : 'border-line bg-surface text-ink-muted hover:bg-surface-muted hover:text-ink'
      }`}
    >
      <span>{paused ? 'Operação pausada' : 'Pausar operação'}</span>
      <span aria-hidden className={`size-2 rounded-full ${paused ? 'bg-danger' : 'bg-positive'}`} />
    </button>
  );
}
