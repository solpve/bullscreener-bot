/** Explorer URL builders. No constants.json import — safe anywhere. */
export const SOLSCAN = {
  account: (address: string) => `https://solscan.io/account/${address}`,
  tx: (signature: string) => `https://solscan.io/tx/${signature}`,
  token: (mint: string) => `https://solscan.io/token/${mint}`,
};
