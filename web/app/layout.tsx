import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import logoMark from '@/public/images/logo-mark.png';
import './globals.css';
import Nav from '@/components/Nav';
import ThemeToggle from '@/components/ThemeToggle';
import Footer from '@/components/Footer';
import { ANSEM, PRE_EXISTING_BURNED_ANSEM } from '@/lib/constants';
import { formatAmount } from '@/lib/format';

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
        url: '/images/og-card.png',
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
    images: ['/images/og-card.png'],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#101a26' },
    { media: '(prefers-color-scheme: light)', color: '#e9eef3' },
  ],
};

/**
 * Applied before first paint so an explicit theme choice never flashes.
 * Absence of the attribute deliberately falls through to prefers-color-scheme.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('bullscreener-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
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
            <ThemeToggle />
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
