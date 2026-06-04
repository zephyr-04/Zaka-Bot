/**
 * security.js — Zaka Security Module
 * Handles private chat enforcement, key validation, message deletion, memory wiping
 */

const { ethers } = require("ethers");

function isPrivateChat(msg) {
  return msg.chat.type === "private";
}

function validateEVMPrivateKey(input) {
  try {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    const raw = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
    const wallet = new ethers.Wallet("0x" + raw);
    return wallet.address;
  } catch {
    return null;
  }
}

function validateSolanaPrivateKey(input) {
  try {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    if (trimmed.length < 80 || trimmed.length > 100) return null;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) return null;
    return true;
  } catch {
    return null;
  }
}

function wipeKey(key) {
  key = null;
  return null;
}

async function deleteMessage(bot, chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch {
    // Silent fail — Telegram limits deletion window
  }
}

module.exports = {
  isPrivateChat,
  validateEVMPrivateKey,
  validateSolanaPrivateKey,
  wipeKey,
  deleteMessage,
};
