/**
 * walletLinks.js — Generate wallet deeplinks for transaction signing
 *
 * Instead of WalletConnect (which requires a persistent WebSocket server),
 * we generate direct deeplinks that open the user's mobile wallet with
 * the transaction pre-filled. User reviews and taps confirm — one step.
 *
 * Supported wallets:
 *  - MetaMask Mobile
 *  - Trust Wallet
 *  - Rainbow
 *  - Coinbase Wallet
 *
 * Security: deeplinks only contain public transaction data (to, data, value, chainId).
 * No private keys, no signatures, no session tokens.
 */

const { EXPLORER_URLS } = require("../config/constants");

/**
 * Generate deeplinks for a transaction across multiple wallets.
 * Returns an array of { wallet, url } objects.
 */
function generateWalletDeeplinks({ to, data, value = "0", chainId }) {
  const valueHex = value && value !== "0"
    ? "0x" + BigInt(Math.round(parseFloat(value) * 1e18)).toString(16)
    : "0x0";

  // EIP-681 transaction URI — standard format most wallets understand
  const eip681 = buildEIP681(to, data, valueHex, chainId);

  return [
    {
      wallet: "MetaMask",
      emoji: "🦊",
      url: `https://metamask.app.link/send/${eip681}`,
    },
    {
      wallet: "Trust Wallet",
      emoji: "🛡️",
      url: `https://link.trustwallet.com/send?asset=c${chainId}&address=${to}&amount=0&memo=${encodeURIComponent(data)}`,
    },
    {
      wallet: "Rainbow",
      emoji: "🌈",
      url: `https://rnbwapp.com/wc?uri=${encodeURIComponent(eip681)}`,
    },
    {
      wallet: "Coinbase Wallet",
      emoji: "🔵",
      url: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(`https://app.across.to`)}`,
    },
  ];
}

/**
 * Build EIP-681 URI
 * Format: ethereum:<address>@<chainId>/transfer?data=<hex>&value=<hex>
 */
function buildEIP681(to, data, valueHex, chainId) {
  let uri = `ethereum:${to}@${chainId}`;
  const params = [];
  if (valueHex && valueHex !== "0x0") params.push(`value=${valueHex}`);
  if (data && data !== "0x") params.push(`data=${data}`);
  if (params.length > 0) uri += `?${params.join("&")}`;
  return uri;
}

/**
 * Format the wallet buttons for Telegram inline keyboard
 */
function buildWalletButtons(deeplinks) {
  return deeplinks.map(d => ([{
    text: `${d.emoji} ${d.wallet}`,
    url: d.url,
  }]));
}

/**
 * Format explorer link for a tx hash
 */
function explorerLink(txHash, chainId) {
  const base = EXPLORER_URLS[chainId];
  if (!base || !txHash) return null;
  return `${base}/tx/${txHash}`;
}

module.exports = { generateWalletDeeplinks, buildWalletButtons, explorerLink };