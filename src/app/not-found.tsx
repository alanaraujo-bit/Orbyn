import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="text-[13px] font-semibold text-ink">Página não encontrada</p>
      <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
        O endereço acessado não existe ou o registro foi removido.
      </p>
      <Link
        href="/"
        className="mt-4 inline-flex min-h-11 items-center rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 md:min-h-0"
      >
        Voltar para a visão geral
      </Link>
    </div>
  );
}
