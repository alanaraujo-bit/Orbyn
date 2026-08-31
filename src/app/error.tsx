'use client';

import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surfaces in the terminal running `next`; the operator sees the message below.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-20 text-center">
      <p className="text-[13px] font-semibold text-danger">Algo falhou ao carregar esta tela</p>
      <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
        {error.message || 'Erro inesperado.'} Se o problema continuar, verifique os alertas e o log do worker.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 min-h-11 rounded-md border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-muted md:min-h-0"
      >
        Tentar novamente
      </button>
    </div>
  );
}
