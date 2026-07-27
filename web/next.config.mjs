import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(webDir, '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // config/constants.json lives above web/ and is the single source of truth
  // shared with bot/. Turbopack scopes module resolution to its root, so the
  // root is widened to the repo and `externalDir` lets the bundler pull that
  // file in directly instead of us duplicating (and drifting from) its values.
  // Next requires turbopack.root and outputFileTracingRoot to agree.
  turbopack: {
    root: repoRoot,
  },
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: repoRoot,
  // Defence in depth: keys/ holds live keypairs and must never be traced into
  // any build output, regardless of what the tracer thinks it found.
  // These globs resolve against outputFileTracingRoot, which is already the
  // repo root — a '../' prefix would point outside it and match nothing. Both
  // forms are listed so the exclusion cannot silently become a no-op if the
  // root moves back to web/.
  outputFileTracingExcludes: {
    '**/*': [
      'keys/**',
      'docs/**',
      '.git/**',
      '../keys/**',
      '../docs/**',
      '../.git/**',
    ],
  },
};

export default nextConfig;
