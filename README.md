# 🌉 Across Cross-Chain Bridge a Telegram Bot

A production-ready Telegram bot that lets users bridge EVM tokens across chains using [Across Protocol](https://across.to) — the fastest intent-based cross-chain bridge.

---

## Architecture

```
User (TG) → Bot → Across API → Quote/Calldata
                             ↓
              User signs in their own wallet
                             ↓
              Across relayer fills on destination
```

**The bot is a quote and routing layer only. It never holds funds or private keys.**

---

## Supported Chains

| Chain       | Chain ID |
|-------------|----------|
| Ethereum    | 1        |
| Optimism    | 10       |
| Polygon     | 137      |
| Base        | 8453     |
| Arbitrum    | 42161    |
| zkSync Era  | 324      |
| Linea       | 59144    |

## Supported Tokens

USDC, USDT, ETH, WBTC, DAI

---

## Setup

### 1. Create a Telegram Bot

Talk to [@BotFather](https://t.me/BotFather):
```
/newbot
→ Follow prompts
→ Copy your BOT_TOKEN
```

### 2. Register Integrator ID

Register at: https://docs.across.to  
Required for mainnet production use. Use `0x0000` for testing.

### 3. Install & Configure

```bash
git clone <repo>
cd across-tg-bridge
npm install
cp .env.example .env
# Edit .env with your BOT_TOKEN and ACROSS_INTEGRATOR_ID
```

### 4. Run

```bash
npm start
# or for development with auto-reload:
npm run dev
```

---

## Bot Commands

| Command   | Description |
|-----------|-------------|
| `/start`  | Welcome + feature overview |
| `/bridge` | Start a cross-chain bridge flow |
| `/status` | Check the status of a pending bridge |
| `/limits` | View current deposit limits from Across |
| `/chains` | List supported chains |
| `/tokens` | List supported tokens |
| `/help`   | FAQ and documentation |

---

## Bridge Flow (User Journey)

```
/bridge
  → Select origin chain         [inline keyboard]
  → Select destination chain    [inline keyboard]
  → Select token                [inline keyboard]
  → Enter amount                [text input, validated]
  → Enter recipient address     [text input, sanitized]
  → Bot fetches live quote      [Across /swap/approval API]
  → Shows quote + calldata      [user reviews]
  → User signs in their wallet  [external — NOT in bot]
  → User confirms sent          [button]
  → Bot shows how to track via /status
```

---

## Security Architecture

### 1. Non-Custodial Design
The bot **never**:
- Stores private keys or mnemonics
- Holds user funds
- Signs transactions on behalf of users
- Has access to wallets

Users sign all transactions in their own wallets. The bot only provides calldata.

### 2. Input Validation (Defense-in-Depth)

All user inputs are sanitized before use:

| Input     | Validation |
|-----------|------------|
| Address   | EIP-55 checksum via ethers.js, regex pre-check |
| Amount    | Positive finite number, max 18 decimals, capped at 1B |
| Chain ID  | Allowlist — only supported chain IDs accepted |
| Deposit ID | Integer only, no special chars |

### 3. Rate Limiting (Per-User)

Two-tier sliding window:
- **General**: Max 10 actions / minute
- **Bridge quotes**: Max 3 quotes / 5 minutes

Prevents API abuse and spam.

### 4. Session Security

- Sessions stored in-memory (no external DB required for basic use)
- Auto-expire after 15 minutes of inactivity
- Cleared immediately on completion, error, or cancel
- Periodic purge of stale sessions
- No sensitive data ever stored in sessions

### 5. Quote Expiry Enforcement

Across quotes include a timestamp valid for ~10 minutes. The bot enforces a 9-minute client-side expiry and rejects stale confirmations.

### 6. API Request Security

- 15-second hard timeout on all Across API requests
- 3-retry exponential backoff (500ms, 1.5s, 3s)
- Only retries on 5xx server errors or timeouts (not 4xx client errors)
- Response validation before returning to bot layer
- No caching of fee/approval endpoints (per Across docs requirement)

### 7. Amount Caps (Bot-Level)

Independent of Across protocol limits:
- Minimum: $5 USD equivalent (relayers won't fill dust amounts)
- Maximum: $50,000 USD equivalent per bridge

For larger amounts, users are directed to app.across.to.

---

## Production Checklist

- [ ] `BOT_TOKEN` set and kept secret (never commit to git)
- [ ] `ACROSS_INTEGRATOR_ID` registered with Across
- [ ] `.env` added to `.gitignore`
- [ ] Bot running on a server with process manager (PM2, systemd)
- [ ] Logs monitored for errors
- [ ] Rate limiting tuned for your expected user volume
- [ ] Consider Redis-backed rate limiter and session store for multi-instance deployments
- [ ] Review Across's terms of service for integrators

---

## Upgrading to Redis (Production Scale)

For multi-instance deployments, replace `SessionManager` and `RateLimiter` with Redis-backed versions:

```bash
npm install ioredis
```

Replace in-memory Maps with Redis keys with TTL. Session keys:
```
session:{userId}     → JSON blob, TTL 15min
ratelimit:{userId}   → sorted set of timestamps
```

---

## Across Protocol Resources

- [Docs](https://docs.across.to)
- [API Reference](https://docs.across.to/reference/api-reference)
- [Discord](https://discord.across.to)
- [GitHub](https://github.com/across-protocol)
- [App](https://app.across.to)

---

## License

MIT
