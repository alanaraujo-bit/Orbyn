export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalida: 'Senha incorreta.',
  sem_senha: 'PANEL_PASSWORD não está configurado no .env deste servidor.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ destino?: string; erro?: string }>;
}) {
  const params = await searchParams;
  const error = params.erro ? MESSAGES[params.erro] : undefined;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-[max(1rem,env(safe-area-inset-top))]">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-md bg-accent text-sm font-bold text-white"
          >
            O
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">Orbyn</p>
            <p className="text-[11px] text-ink-faint">Painel operacional</p>
          </div>
        </div>

        <form
          action="/api/auth/login"
          method="post"
          className="rounded-lg border border-line bg-surface p-5"
        >
          <label htmlFor="senha" className="mb-1.5 block text-[13px] font-medium text-ink">
            Senha do painel
          </label>
          <input
            id="senha"
            name="senha"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            className="min-h-11 w-full rounded-md border border-line bg-transparent px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
          />
          <input type="hidden" name="destino" value={params.destino ?? '/'} />

          {error ? (
            <p role="alert" className="mt-3 text-[12px] text-danger">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="mt-4 min-h-11 w-full rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-white"
          >
            Entrar
          </button>
        </form>

        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
          Este painel controla uma conta real do Instagram e exibe dados de pessoas. O endereço
          público é acessível a qualquer um que o descubra — a senha é o que separa os dois.
        </p>
      </div>
    </main>
  );
}
