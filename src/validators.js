const { ethers } = require("ethers");
const { SUPPORTED_CHAINS } = require("../config/constants");

const SUPPORTED_CHAIN_IDS = new Set(SUPPORTED_CHAINS.map(c => c.id));

function sanitizeAddress(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  try {
    return ethers.getAddress(trimmed);
  } catch {
    try {
      return ethers.getAddress(trimmed.toLowerCase());
    } catch {
      return null;
    }
  }
}

function sanitizeAmount(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/,/g, ".");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const num = parseFloat(trimmed);
  if (!isFinite(num) || num <= 0) return null;
  const parts = trimmed.split(".");
  if (parts[1] && parts[1].length > 18) return null;
  if (num > 1_000_000_000) return null;
  return trimmed;
}

function sanitizeChainId(input) {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const id = parseInt(input.toString().trim(), 10);
  if (!isFinite(id) || id <= 0) return null;
  if (!SUPPORTED_CHAIN_IDS.has(id)) return null;
  return id;
}

module.exports = { sanitizeAddress, sanitizeAmount, sanitizeChainId };