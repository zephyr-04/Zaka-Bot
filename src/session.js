const FLOW_TTL_MS = 15 * 60 * 1000;

class SessionManager {
  constructor() {
    this._walletStore = new Map();
    this._flowStore = new Map();
    setInterval(() => this._purgeExpiredFlows(), 5 * 60 * 1000);
  }

  // ── Wallet store (persistent) ────────────────────────────────────────────

  storeWallet(userId, { privyUserId, walletAddress, walletId }) {
    this._walletStore.set(userId, { privyUserId, walletAddress, walletId });
  }

  getWallet(userId) {
    return this._walletStore.get(userId) || null;
  }

  clearWallet(userId) {
    this._walletStore.delete(userId);
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