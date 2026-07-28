import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { Unbounded } from 'next/font/google';
import logoMark from '@/public/images/logo-mark-v2.png';
import './globals.css';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { ANSEM, PRE_EXISTING_BURNED_ANSEM } from '@/lib/constants';
import { formatAmount } from '@/lib/format';
import { GITHUB_REPO } from '@/lib/links';

/**
 * Display face for headlines and section titles — globals.css reads it as
 * --font-display and falls back to the mono stack if it ever fails to load.
 */
const display = Unbounded({
  subsets: ['latin'],
  weight: ['500', '700', '800'],
  variable: '--font-display',
});

export const metadata: Metadata = {
  /* www is the canonical host — the apex 308s to it — so every absolute URL
     search engines see (OG images, canonicals, sitemap) must be built on it. */
  metadataBase: new URL('https://www.bullscreener.xyz'),
  title: {
    default: 'bullscreener — pump.fun creator fees, routed to $ANSEM burns',
    template: '%s — bullscreener',
  },
  description:
    'A public screener for pump.fun coins whose creator fees are routed — irreversibly by the deployer — into open-market $ANSEM buybacks and Token-2022 burns. Every figure is derived from chain at request time.',
  applicationName: 'bullscreener',
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: 'bullscreener',
    title: 'bullscreener — creator fees routed to burns, proved on-chain',
    description:
      'Coins routing pump.fun creator fees — irreversibly by the deployer — into $ANSEM buybacks and burns, with the on-chain proof for every listing criterion.',
    images: [
      {
        url: '/images/og-card-v2.png',
        width: 1200,
        height: 630,
        alt: 'The bullscreener bull mark',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'bullscreener — creator fees routed to burns, proved on-chain',
    description:
      'Coins routing pump.fun creator fees — irreversibly by the deployer — into $ANSEM buybacks and burns, with the on-chain proof for every listing criterion.',
    images: ['/images/og-card-v2.png'],
  },
};

/* Dark-only by design (owner decision 2026-07-28) — the terminal has one
   look. No theme toggle, no prefers-color-scheme branching. */
export const viewport: Viewport = {
  themeColor: '#070d16',
};

/* Structured data for search. Facts only — the same claims the pages make:
   what the site is, where it lives, what it looks like. No ratings, no
   invented entities. */
const JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'bullscreener',
  url: 'https://www.bullscreener.xyz',
  description:
    'A public screener for pump.fun coins whose creator fees are routed — irreversibly by the deployer — into open-market $ANSEM buybacks and Token-2022 burns.',
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={display.variable}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON_LD }}
        />
        <header className="masthead">
          <div className="shell masthead__inner">
            <Link href="/" className="wordmark">
              <Image
                className="wordmark__mark"
                src={logoMark}
                alt=""
                width={26}
                height={26}
                priority
              />
              bullscreener
            </Link>
            <Nav />
            <a
              className="masthead__gh"
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Source code on GitHub"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span className="masthead__gh-label">GitHub</span>
            </a>
          </div>
        </header>
        <main>{children}</main>
        <Footer
          ansemMint={ANSEM.mint}
          preExistingBurned={formatAmount(PRE_EXISTING_BURNED_ANSEM, 2)}
        />
      </body>
    </html>
  );
}
