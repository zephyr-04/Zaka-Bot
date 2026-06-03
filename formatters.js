/**
 * formatters.js — Display helpers
 */

const { SUPPORTED_CHAINS, EXPLORER_URLS } = require("../config/constants");

function formatChainName(chainId) {
  const chain = SUPPORTED_CHAINS.find(c => c.id === chainId);
  return chain?.name || `Chain ${chainId}`;
}

function formatFees(fees, symbol) {
  if (!fees) return "_Fee data unavailable_";

  const lines = [];
  if (fees.lpFee) lines.push(`  • LP fee: ${fees.lpFee}`);
  if (fees.relayerFee) lines.push(`  • Relayer fee: ${fees.relayerFee}`);
  if (fees.totalFee) lines.push(`  • *Total fee: ${fees.totalFee}*`);
  if (fees.totalFeeAmount) lines.push(`    _(≈ ${parseFloat(fees.totalFeeAmount).toFixed(6)} ${symbol})_`);

  return lines.length > 0
    ? `*Fees:*\n${lines.join("\n")}`
    : "_No fee breakdown available_";
}

function formatTxLink(txHash, chainId) {
  const explorer = EXPLORER_URLS[chainId];
  if (!explorer || !txHash) return `\`${txHash || "N/A"}\``;
  return `[View on Explorer](${explorer}/tx/${txHash})`;
}

module.exports = { formatChainName, formatFees, formatTxLink };
