'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly hint: string;
}

/** Sidebar navigation; the current section is marked for sighted and screen-reader users. */
export function Nav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      className="-mx-1 flex gap-0.5 overflow-x-auto px-1 lg:mx-0 lg:flex-col lg:px-0"
    >
      {items.map((item) => {
        const active =
          item.href === pathname ||
          (pathname.startsWith(`${item.href}/`) && item.href.split('/').length > 3);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`group flex shrink-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
              active ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-accent' : 'bg-line-strong group-hover:bg-faint'}`}
              />
              {item.label}
            </span>
            <kbd className="hidden font-mono text-2xs text-faint lg:inline">{item.hint}</kbd>
          </Link>
        );
      })}
    </nav>
  );
}
