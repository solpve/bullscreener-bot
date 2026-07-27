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
  metadataBase: new URL('https://bullscreener.xyz'),
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={display.variable}>
      <body>
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
