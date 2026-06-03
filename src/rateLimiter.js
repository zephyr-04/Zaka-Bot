class RateLimiter {
  constructor({
    windowMs = 60_000,
    maxRequests = 10,
    bridgeWindowMs = 300_000,
    maxBridges = 3,
  } = {}) {
    this._windowMs = windowMs;
    this._maxRequests = maxRequests;
    this._bridgeWindowMs = bridgeWindowMs;
    this._maxBridges = maxBridges;
    this._requests = new Map();
    this._bridges = new Map();
    setInterval(() => this._purge(), 10 * 60 * 1000);
  }

  check(userId) {
    return this._allow(this._requests, userId, this._windowMs, this._maxRequests);
  }

  checkBridge(userId) {
    return (
      this._allow(this._requests, userId, this._windowMs, this._maxRequests) &&
      this._allow(this._bridges, userId, this._bridgeWindowMs, this._maxBridges)
    );
  }

  _allow(store, userId, windowMs, max) {
    const now = Date.now();
    const windowStart = now - windowMs;
    let timestamps = store.get(userId) || [];
    timestamps = timestamps.filter(t => t > windowStart);
    if (timestamps.length >= max) return false;
    timestamps.push(now);
    store.set(userId, timestamps);
    return true;
  }

  _purge() {
    const now = Date.now();
    for (const [id, ts] of this._requests) {
      if (now - Math.max(...ts) > this._windowMs * 2) this._requests.delete(id);
    }
    for (const [id, ts] of this._bridges) {
      if (now - Math.max(...ts) > this._bridgeWindowMs * 2) this._bridges.delete(id);
    }
  }
}

module.exports = { RateLimiter };