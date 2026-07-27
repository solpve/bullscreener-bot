import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // The pump SDK's ESM build pulls in CJS-only packages (anchor,
        // agent-payments-sdk). Inlining lets Vite apply CJS interop instead of
        // Node's stricter named-export resolution. `tsx` handles this natively,
        // so this is a test-runner concern only.
        inline: ['@pump-fun/pump-sdk', '@pump-fun/agent-payments-sdk', '@pump-fun/pump-swap-sdk'],
      },
    },
  },
});
