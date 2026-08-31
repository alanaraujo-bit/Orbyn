'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult } from '@/app/_actions/operations';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:opacity-90 border-transparent',
  secondary: 'bg-surface text-ink border-line hover:bg-surface-muted',
  // The borderless look works next to other controls in a dense table. On a
  // phone the row is a card and a borderless button reads as a caption, so it
  // gets an outline there — the operator must be able to see what is tappable.
  ghost: 'bg-transparent text-ink-muted border-transparent max-md:border-line hover:bg-surface-muted hover:text-ink',
  danger: 'bg-transparent text-danger border-danger/30 hover:bg-danger-soft',
};

export interface ActionButtonProps {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  variant?: Variant;
  /** Shown in a confirmation step; only use it for genuinely destructive acts. */
  confirm?: string;
  disabled?: boolean;
  title?: string;
  /** Full width on a phone: for the standalone controls on the lead page. */
  block?: boolean;
}

/**
 * Runs a server action with a pending state and an inline result. Confirmation
 * is opt-in and reserved for destructive operations.
 */
export function ActionButton({ action, children, variant = 'secondary', confirm, disabled, title, block }: ActionButtonProps) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  const run = (): void => {
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      setConfirming(false);
      if (outcome.ok) router.refresh();
    });
  };

  // `min-h-11` is the 44px a thumb needs; the desktop keeps its denser button.
  const touch = 'min-h-11 md:min-h-0';
  const width = block ? 'w-full justify-center md:w-auto' : '';

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-ink-muted">{confirm}</span>
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className={`rounded-md border border-danger/30 bg-danger-soft px-3 py-1 text-[12px] font-medium text-danger disabled:opacity-60 ${touch}`}
        >
          {pending ? 'Confirmando…' : 'Confirmar'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={`rounded-md px-3 py-1 text-[12px] text-ink-muted hover:text-ink ${touch}`}
        >
          Cancelar
        </button>
      </span>
    );
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${block ? 'w-full md:w-auto' : ''}`}>
      <button
        type="button"
        title={title}
        disabled={disabled || pending}
        onClick={() => (confirm ? setConfirming(true) : run())}
        className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${touch} ${width} ${VARIANT_CLASS[variant]}`}
      >
        {pending ? 'Processando…' : children}
      </button>
      {result && !result.ok ? (
        <span role="alert" className="text-[12px] text-danger">
          {result.message}
        </span>
      ) : null}
      {result?.ok ? (
        <span role="status" className="text-[12px] text-positive">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
