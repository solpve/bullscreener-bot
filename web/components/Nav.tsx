'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Screener' },
  { href: '/burns', label: 'Burns' },
  { href: '/route-your-fees', label: 'Route your fees' },
];

export default function Nav() {
  // usePathname() is typed as string but can be null while the router is not
  // yet mounted (notably inside the not-found boundary); an unguarded
  // .startsWith() there would take the whole layout down with it.
  const pathname = usePathname() ?? '';

  return (
    <nav className="nav" aria-label="Primary">
      {LINKS.map(({ href, label }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`nav__link${active ? ' nav__link--active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
