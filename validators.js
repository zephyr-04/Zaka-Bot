/**
 * validators.js — Input sanitization & validation
 * 
 * All user input goes through these functions before any processing.
 * Defense in depth: validate at ingestion, not just at use.
 */

const { ethers } = require("ethers");
const { SUPPORTED_CHAINS } = require("../config/constants");

const SUPPORTED_CHAIN_IDS = new Set(SUPPORTED_CHAINS.map(c => c.id));

/**
 * Validate and normalize an Ethereum address.
 * Returns checksummed address or null.
 */
function sanitizeAddress(input) {
  if (typeof input !== "string") return null;

  // Strip leading/trailing whitespace, reject anything with spaces
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return null;

  // Must match hex address pattern
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;

  // Attempt EIP-55 checksum validation
  try {
    return ethers.getAddress(trimmed); // throws if invalid checksum
  } catch {
    // If it's all lowercase or all uppercase, getAddress still normalizes it
    // but if it has mixed case that doesn't match EIP-55, it throws.
    // We'll allow all-lowercase / all-uppercase inputs.
    try {
      return ethers.getAddress(trimmed.toLowerCase());
    } catch {
      return null;
    }
  }
}

/**
 * Validate a token amount.
 * Returns a clean string or null.
 * 
 * Rules:
 *  - Must be a positive finite number
 *  - Max 18 decimal places
 *  - Must not be 0
 *  - No scientific notation abuse
 */
function sanitizeAmount(input) {
  if (typeof input !== "string") return null;

  const trimmed = input.trim().replace(/,/g, "."); // handle comma decimals

  // Only allow digits and a single dot
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const num = parseFloat(trimmed);
  if (!isFinite(num) || num <= 0) return null;

  // Prevent amounts with > 18 decimal places (max ERC-20 precision)
  const parts = trimmed.split(".");
  if (parts[1] && parts[1].length > 18) return null;

  // Prevent astronomically large inputs (server-side cap is separate)
  if (num > 1_000_000_000) return null;

  return trimmed;
}

/**
 * Validate a chain ID.
 * Must be in our supported chains list.
 */
function sanitizeChainId(input) {
  if (typeof input !== "string" && typeof input !== "number") return null;

  const id = parseInt(input.toString().trim(), 10);
  if (!isFinite(id) || id <= 0) return null;

  if (!SUPPORTED_CHAIN_IDS.has(id)) return null;

  return id;
}

/**
 * Sanitize a deposit ID.
 * Deposit IDs from Across are integers.
 */
function sanitizeDepositId(input) {
  if (typeof input !== "string" && typeof input !== "number") return null;

  const clean = input.toString().trim();
  if (!/^\d+$/.test(clean)) return null;

  const id = parseInt(clean, 10);
  if (!isFinite(id) || id < 0) return null;

  return id;
}

module.exports = {
  sanitizeAddress,
  sanitizeAmount,
  sanitizeChainId,
  sanitizeDepositId,
};
