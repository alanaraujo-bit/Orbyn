'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { importLeadsAction, type ImportResult } from '@/app/_actions/operations';
import type { Funnel } from '@/features/leads/states';

/** Manual lead import: the discovery path that always works, with no browser. */
export function ImportLeads({ funnel, disabled, disabledReason }: { funnel: Funnel; disabled?: boolean; disabledReason?: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (disabled) {
    return (
      <p className="text-[12px] text-ink-faint" role="note">
        {disabledReason ?? 'Importação indisponível.'}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 w-full rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 sm:w-auto md:min-h-0"
      >
        Importar perfis
      </button>
    );
  }

  const submit = (): void => {
    setResult(null);
    startTransition(async () => {
      const outcome = await importLeadsAction(funnel, value);
      setResult(outcome);
      if (outcome.ok) {
        setValue('');
        router.refresh();
      }
    });
  };

  return (
    <div className="card w-full p-3 sm:max-w-xl">
      <label htmlFor="handles" className="text-[12.5px] font-medium text-ink">
        Perfis do Instagram
      </label>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        Um por linha. Aceita <code className="text-ink">@perfil</code>, <code className="text-ink">perfil</code> ou a URL
        completa.
      </p>
      <textarea
        id="handles"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={6}
        spellCheck={false}
        placeholder={'@distribuidora_exemplo\ninstagram.com/mercado_exemplo'}
        className="mt-2 w-full rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || value.trim().length === 0}
          className="min-h-11 flex-1 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50 sm:flex-none md:min-h-0"
        >
          {pending ? 'Importando…' : 'Importar'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
          className="min-h-11 rounded-md px-3 py-1.5 text-[12.5px] text-ink-muted hover:text-ink md:min-h-0"
        >
          Fechar
        </button>
      </div>

      {result ? (
        <div role="status" className="mt-2 text-[12px]">
          <p className={result.ok ? 'text-positive' : 'text-danger'}>{result.message}</p>
          {result.invalid.length > 0 ? (
            <p className="mt-1 text-ink-muted">Ignorados por formato inválido: {result.invalid.join(', ')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
