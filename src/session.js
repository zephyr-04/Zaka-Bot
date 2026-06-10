const fs = require("fs");
const path = require("path");

const FLOW_TTL_MS = 15 * 60 * 1000;
const WALLET_FILE = path.join(__dirname, "../data/wallets.json");

function ensureDataDir() {
  const dir = path.dirname(WALLET_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadWallets() {
  try {
    ensureDataDir();
    if (!fs.existsSync(WALLET_FILE)) return {};
    return JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveWallets(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save wallets:", err.message);
  }
}

class SessionManager {
  constructor() {
    this._walletStore = loadWallets();
    this._flowStore = new Map();
    setInterval(() => this._purgeExpiredFlows(), 5 * 60 * 1000);
  }

  // ── Wallet store (persistent) ────────────────────────────────────────────

  storeWallet(userId, { privyUserId, walletAddress, walletId, type }) {
    this._walletStore[userId] = { privyUserId, walletAddress, walletId, type };
    saveWallets(this._walletStore);
  }

  getWallet(userId) {
    return this._walletStore[userId] || null;
  }

  clearWallet(userId) {
    delete this._walletStore[userId];
    saveWallets(this._walletStore);
  }

  // ── Flow store (TTL-based) ───────────────────────────────────────────────

  setFlow(userId, data) {
    this._flowStore.set(userId, { ...data, _updatedAt: Date.now() });
  }

  getFlow(userId) {
    const flow = this._flowStore.get(userId);
    if (!flow) return null;
    if (Date.now() - flow._updatedAt > FLOW_TTL_MS) {
      this._flowStore.delete(userId);
      return null;
    }
    return flow;
  }

  updateFlow(userId, patch) {
    const existing = this.getFlow(userId);
    if (!existing) return;
    this._flowStore.set(userId, { ...existing, ...patch, _updatedAt: Date.now() });
  }

  clearFlow(userId) {
    this._flowStore.delete(userId);
  }

  // Legacy aliases
  set(userId, data) { this.setFlow(userId, data); }
  get(userId) { return this.getFlow(userId); }
  update(userId, patch) { this.updateFlow(userId, patch); }
  clear(userId) { this.clearFlow(userId); }

  _purgeExpiredFlows() {
    const now = Date.now();
    for (const [userId, flow] of this._flowStore.entries()) {
      if (now - flow._updatedAt > FLOW_TTL_MS) {
        this._flowStore.delete(userId);
      }
    }
  }
}

module.exports = { SessionManager };