/**
 * SessionManager — In-memory session store with TTL
 *
 * Sessions are per-user (by Telegram user ID).
 * They hold the current bridge flow state: step, chain selections, token, amount, quote.
 *
 * Security:
 *  - Sessions expire after SESSION_TTL_MS (default: 15 minutes)
 *  - No sensitive data (private keys, mnemonics) ever stored
 *  - Sessions automatically cleared on completion or error
 */

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

class SessionManager {
  constructor() {
    this._store = new Map();
    // Purge expired sessions every 5 minutes
    setInterval(() => this._purgeExpired(), 5 * 60 * 1000);
  }

  set(userId, data) {
    this._store.set(userId, {
      ...data,
      _createdAt: Date.now(),
      _updatedAt: Date.now(),
    });
  }

  get(userId) {
    const session = this._store.get(userId);
    if (!session) return null;

    // Check TTL
    if (Date.now() - session._updatedAt > SESSION_TTL_MS) {
      this._store.delete(userId);
      return null;
    }

    return session;
  }

  update(userId, patch) {
    const existing = this.get(userId);
    if (!existing) return;

    this._store.set(userId, {
      ...existing,
      ...patch,
      _updatedAt: Date.now(),
    });
  }

  clear(userId) {
    this._store.delete(userId);
  }

  _purgeExpired() {
    const now = Date.now();
    for (const [userId, session] of this._store.entries()) {
      if (now - session._updatedAt > SESSION_TTL_MS) {
        this._store.delete(userId);
      }
    }
  }
}

module.exports = { SessionManager };
