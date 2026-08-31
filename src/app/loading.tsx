export default function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <div className="h-6 w-48 animate-pulse rounded bg-surface-muted" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-[76px] animate-pulse rounded-[10px] bg-surface-muted" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-[10px] bg-surface-muted" />
      <span className="sr-only">Carregando…</span>
    </div>
  );
}
