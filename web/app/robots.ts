import type { MetadataRoute } from 'next';

/** Served at /robots.txt. Everything is public; the API is data, not pages. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: 'https://www.bullscreener.xyz/sitemap.xml',
  };
}
