'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/**
 * Keyboard-first navigation: `/` focuses the page's search or question box,
 * `g` then a letter jumps to a section (o overview, i investigate, f files,
 * g graph, d dependencies).
 */
export function Shortcuts({ base }: { base: string }) {
  const router = useRouter();
  useEffect(() => {
    let pendingG = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.key === '/') {
        const box = document.querySelector<HTMLElement>('[data-shortcut="search"]');
        if (box) {
          event.preventDefault();
          box.focus();
        }
        return;
      }
      if (pendingG) {
        pendingG = false;
        const target = { o: '', i: '/investigate', f: '/files', g: '/graph', d: '/dependencies' }[
          event.key
        ];
        if (target !== undefined) router.push(`${base}${target}`);
        return;
      }
      pendingG = event.key === 'g';
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [base, router]);
  return null;
}
