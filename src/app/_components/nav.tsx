'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  badge?: number;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export function Nav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-5 px-3 py-4">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="px-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {group.title}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-9 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                      active
                        ? 'bg-accent-soft font-medium text-accent-ink'
                        : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.badge !== undefined && item.badge > 0 ? (
                      <span className="num rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold text-danger">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
