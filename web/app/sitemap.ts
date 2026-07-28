import type { MetadataRoute } from 'next';

/** Served at /sitemap.xml. URLs are on the canonical www host. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://www.bullscreener.xyz';
  return [
    { url: `${base}/`, changeFrequency: 'hourly', priority: 1 },
    { url: `${base}/route-your-fees`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/burns`, changeFrequency: 'hourly', priority: 0.8 },
  ];
}
