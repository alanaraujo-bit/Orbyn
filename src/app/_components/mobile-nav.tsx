'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icons';

/**
 * The phone's navigation: a fixed bottom tab bar, plus a sheet for everything
 * that does not fit in it.
 *
 * Five tabs is the ceiling — past that the targets fall under the ~44px a thumb
 * needs. So the four screens worth checking on the move get a tab, and the rest
 * live behind "Mais". The master pause lives in that sheet too: on the desktop
 * sidebar it sits in a rail that is `hidden` below `md`, which left the phone
 * with no way to stop the operation at all.
 */

export interface MobileNavLink {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
}

export function MobileNav({
  tabs,
  moreLinks,
  pauseControl,
  capabilities,
  install,
}: {
  tabs: MobileNavLink[];
  moreLinks: MobileNavLink[];
  /** Server-rendered <GlobalPause>, so the sheet needs no data of its own. */
  pauseControl: ReactNode;
  capabilities: ReactNode;
  /** The install offer, for finding it again after the banner is dismissed. */
  install: ReactNode;
}) {
  const pathname = usePathname();

  /*
   * The sheet is open "on a route", not open as a fact of its own. Recording
   * where it was opened means a navigation closes it for free: `pathname`
   * changes, the two stop matching, and there is no effect chasing the router.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === pathname;
  const setOpen = (next: boolean): void => setOpenedAt(next ? pathname : null);

  // While the sheet is up, the page behind it must not scroll under the thumb.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenedAt(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const moreActive = moreLinks.some((link) => isActive(pathname, link.href));
  const moreBadge = moreLinks.reduce((total, link) => total + (link.badge ?? 0), 0);

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Mais opções"
            className="sheet-in absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <div className="sticky top-0 flex items-center justify-between gap-3 rounded-t-2xl border-b border-line bg-surface px-4 pt-2 pb-3">
              <span aria-hidden className="absolute inset-x-0 top-2 mx-auto h-1 w-9 rounded-full bg-line-strong" />
              <p className="mt-3 text-[13px] font-semibold text-ink">Mais</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mt-3 -mr-2 grid size-11 place-items-center rounded-lg text-ink-muted active:bg-surface-muted"
              >
                <span aria-hidden className="text-[20px] leading-none">
                  ×
                </span>
                <span className="sr-only">Fechar</span>
              </button>
            </div>

            <div className="px-4 py-3">{pauseControl}</div>

            <nav aria-label="Mais telas" className="px-2 pb-2">
              <ul className="flex flex-col">
                {moreLinks.map((link) => {
                  const active = isActive(pathname, link.href);
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        aria-current={active ? 'page' : undefined}
                        className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-[14px] active:bg-surface-muted ${
                          active ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink'
                        }`}
                      >
                        <Icon name={link.icon} className="size-5 shrink-0 text-ink-faint" />
                        <span className="flex-1 truncate">{link.label}</span>
                        {link.badge ? (
                          <span className="num rounded-full bg-danger-soft px-2 py-0.5 text-[11.5px] font-semibold text-danger">
                            {link.badge}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="border-t border-line px-4 py-3">
              <p className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">Capacidades</p>
              {capabilities}
            </div>

            {install}
          </div>
        </div>
      ) : null}

      <nav
        aria-label="Navegação principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="mx-auto flex max-w-lg items-stretch">
          {tabs.map((tab) => {
            const active = isActive(pathname, tab.href);
            return (
              <li key={tab.href} className="flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex min-h-14 flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 text-[10.5px] leading-none transition-colors ${
                    active ? 'text-accent-ink' : 'text-ink-faint'
                  }`}
                >
                  <span className="relative">
                    <Icon name={tab.icon} />
                    {tab.badge ? (
                      <span className="num absolute -top-1.5 -right-2.5 min-w-[17px] rounded-full bg-danger px-1 text-center text-[10px] leading-[17px] font-semibold text-white">
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="max-w-full truncate">{tab.label}</span>
                </Link>
              </li>
            );
          })}

          <li className="flex-1">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-expanded={open}
              aria-haspopup="dialog"
              className={`relative flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 pt-1.5 pb-1 text-[10.5px] leading-none ${
                moreActive ? 'text-accent-ink' : 'text-ink-faint'
              }`}
            >
              <span className="relative">
                <Icon name="more" />
                {moreBadge ? (
                  <span aria-hidden className="absolute -top-0.5 -right-1.5 size-2 rounded-full bg-danger" />
                ) : null}
              </span>
              <span>Mais</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
