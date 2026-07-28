/** Explorer URL builders. No constants.json import — safe anywhere. */
export const SOLSCAN = {
  account: (address: string) => `https://solscan.io/account/${address}`,
  tx: (signature: string) => `https://solscan.io/tx/${signature}`,
  token: (mint: string) => `https://solscan.io/token/${mint}`,
};

/** The public mirror of this codebase — the keeper bot and this site. */
export const GITHUB_REPO = 'https://github.com/solpve/bullscreener-bot';
