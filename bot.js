/**
 * Across Protocol Cross-Chain Bridge - Telegram Bot
 * 
 * Architecture: Stateless quote + approval flow. Users connect their own wallet
 * via deeplink or wallet connect URI. The bot NEVER holds private keys.
 * 
 * Security model:
 *  - Bot is quote/routing layer only
 *  - All signing happens client-side (user's wallet)
 *  - Rate limiting per user ID
 *  - Amount caps enforced before quoting
 *  - Input sanitization on all user inputs
 *  - No PK storage, no custodial flow
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { AcrossService } = require("./across");
const { SessionManager } = require("./session");
const { RateLimiter } = require("./rateLimiter");
const { sanitizeAddress, sanitizeAmount, sanitizeChainId } = require("./validators");
const { SUPPORTED_CHAINS, SUPPORTED_TOKENS, BOT_CONFIG } = require("../config/constants");
const { formatFees, formatChainName, formatTxLink } = require("./formatters");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const across = new AcrossService();
const sessions = new SessionManager();
const limiter = new RateLimiter({
  windowMs: 60_000,      // 1 minute window
  maxRequests: 10,        // max 10 actions per user per minute
  bridgeWindowMs: 300_000, // 5 min window for bridge initiations
  maxBridges: 3,          // max 3 bridge quotes per 5 min (anti-spam)
});

// ─── /start ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!limiter.check(userId)) {
    return bot.sendMessage(chatId, "⚠️ You're sending requests too fast. Please wait a moment.");
  }

  sessions.clear(userId);

  await bot.sendMessage(chatId,
    `🌉 *Across Cross-Chain Bridge*\n\n` +
    `Bridge tokens across EVM chains in seconds using Across Protocol's intent-based architecture.\n\n` +
    `*Supported chains:*\n${SUPPORTED_CHAINS.map(c => `  • ${c.name}`).join("\n")}\n\n` +
    `*Commands:*\n` +
    `/bridge — Start a bridge transaction\n` +
    `/status — Check a pending bridge status\n` +
    `/limits — View current deposit limits\n` +
    `/chains — View supported chains\n` +
    `/tokens — View supported tokens\n` +
    `/help — Help & FAQ\n\n` +
    `⚠️ *Security notice:* This bot never stores your private keys or holds funds. ` +
    `All transactions are signed in your own wallet.`,
    { parse_mode: "Markdown" }
  );
});

// ─── /bridge ───────────────────────────────────────────────────────────────

bot.onText(/\/bridge/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!limiter.checkBridge(userId)) {
    return bot.sendMessage(chatId,
      "⚠️ Too many bridge requests. Please wait a few minutes before starting a new quote."
    );
  }

  sessions.clear(userId);
  sessions.set(userId, { step: "SELECT_ORIGIN_CHAIN" });

  const chainButtons = SUPPORTED_CHAINS.map(c => ([{
    text: c.name,
    callback_data: `origin_chain:${c.id}`,
  }]));

  await bot.sendMessage(chatId,
    "🔀 *New Bridge*\n\nStep 1/5 — Select *origin chain* (where your tokens are now):",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: chainButtons },
    }
  );
});

// ─── /status ───────────────────────────────────────────────────────────────

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!limiter.check(userId)) return;

  sessions.clear(userId);
  sessions.set(userId, { step: "AWAIT_STATUS_INPUT" });

  await bot.sendMessage(chatId,
    "🔍 *Check Bridge Status*\n\n" +
    "Enter your `originChainId` and `depositId` separated by a space:\n\n" +
    "Example: `10 12345`\n\n" +
    "_(You can find these in your wallet transaction details or the bridge confirmation message)_",
    { parse_mode: "Markdown" }
  );
});

// ─── /limits ───────────────────────────────────────────────────────────────

bot.onText(/\/limits/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!limiter.check(userId)) return;

  await bot.sendMessage(chatId, "⏳ Fetching current protocol limits...");

  try {
    const limits = await across.getLimits();
    const text = limits.map(l =>
      `*${l.symbol}* (${formatChainName(l.originChainId)} → ${formatChainName(l.destinationChainId)})\n` +
      `  Min: ${l.minDeposit} | Max: ${l.maxDeposit}`
    ).join("\n\n");

    await bot.sendMessage(chatId,
      `📊 *Current Bridge Limits*\n\n${text || "No limits data available."}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Failed to fetch limits: ${err.message}`);
  }
});

// ─── /chains & /tokens ─────────────────────────────────────────────────────

bot.onText(/\/chains/, async (msg) => {
  const chatId = msg.chat.id;
  const chainList = SUPPORTED_CHAINS.map(c =>
    `• *${c.name}* — Chain ID: \`${c.id}\``
  ).join("\n");
  await bot.sendMessage(chatId, `⛓️ *Supported Chains*\n\n${chainList}`, { parse_mode: "Markdown" });
});

bot.onText(/\/tokens/, async (msg) => {
  const chatId = msg.chat.id;
  const tokenList = SUPPORTED_TOKENS.map(t =>
    `• *${t.symbol}* — ${t.name}`
  ).join("\n");
  await bot.sendMessage(chatId, `🪙 *Supported Tokens*\n\n${tokenList}`, { parse_mode: "Markdown" });
});

// ─── /help ─────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `❓ *FAQ & Help*\n\n` +
    `*How does this work?*\n` +
    `This bot fetches a live quote from Across Protocol and generates the transaction calldata. ` +
    `You sign it in your own wallet — the bot never touches your funds.\n\n` +
    `*What's an Integrator ID?*\n` +
    `A unique ID registered with Across to track your integration. Required for mainnet.\n\n` +
    `*Why is my quote expired?*\n` +
    `Quotes include a timestamp valid for ~10 minutes. If expired, start a new /bridge flow.\n\n` +
    `*Who do I contact for support?*\n` +
    `Across Protocol Discord: https://discord.across.to\n\n` +
    `*Is this custodial?*\n` +
    `No. The bot is purely a routing and quote layer. You always control your keys.`,
    { parse_mode: "Markdown" }
  );
});

// ─── CALLBACK QUERY HANDLER ────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (!limiter.check(userId)) {
    return bot.answerCallbackQuery(query.id, { text: "Slow down! Too many actions." });
  }

  await bot.answerCallbackQuery(query.id);

  const session = sessions.get(userId);
  if (!session) {
    return bot.sendMessage(chatId, "Session expired. Please start again with /bridge.");
  }

  // ── Select origin chain
  if (data.startsWith("origin_chain:") && session.step === "SELECT_ORIGIN_CHAIN") {
    const chainId = parseInt(data.split(":")[1]);
    const chain = SUPPORTED_CHAINS.find(c => c.id === chainId);
    if (!chain) return;

    sessions.update(userId, { originChainId: chainId, step: "SELECT_DEST_CHAIN" });

    const destChains = SUPPORTED_CHAINS
      .filter(c => c.id !== chainId)
      .map(c => ([{ text: c.name, callback_data: `dest_chain:${c.id}` }]));

    await bot.sendMessage(chatId,
      `✅ Origin: *${chain.name}*\n\nStep 2/5 — Select *destination chain*:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: destChains } }
    );
  }

  // ── Select destination chain
  else if (data.startsWith("dest_chain:") && session.step === "SELECT_DEST_CHAIN") {
    const chainId = parseInt(data.split(":")[1]);
    const chain = SUPPORTED_CHAINS.find(c => c.id === chainId);
    if (!chain) return;

    sessions.update(userId, { destinationChainId: chainId, step: "SELECT_TOKEN" });

    const tokenButtons = SUPPORTED_TOKENS.map(t => ([{
      text: `${t.symbol} — ${t.name}`,
      callback_data: `token:${t.symbol}`,
    }]));

    await bot.sendMessage(chatId,
      `✅ Destination: *${chain.name}*\n\nStep 3/5 — Select *token* to bridge:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
  }

  // ── Select token
  else if (data.startsWith("token:") && session.step === "SELECT_TOKEN") {
    const symbol = data.split(":")[1];
    const token = SUPPORTED_TOKENS.find(t => t.symbol === symbol);
    if (!token) return;

    sessions.update(userId, { token: symbol, step: "AWAIT_AMOUNT" });

    await bot.sendMessage(chatId,
      `✅ Token: *${symbol}*\n\nStep 4/5 — Enter the *amount* to bridge:\n\n` +
      `_(e.g. \`10.5\` for ${symbol})_\n\n` +
      `⚠️ Min: ${BOT_CONFIG.MIN_AMOUNT_USD} USD equivalent | Max: ${BOT_CONFIG.MAX_AMOUNT_USD} USD equivalent`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Confirm bridge (after quote shown)
  else if (data === "confirm_bridge" && session.step === "CONFIRM") {
    await executeBridge(chatId, userId, session);
  }

  // ── Cancel
  else if (data === "cancel") {
    sessions.clear(userId);
    await bot.sendMessage(chatId, "❌ Bridge cancelled. Use /bridge to start a new one.");
  }
});

// ─── TEXT MESSAGE HANDLER ──────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  if (!text || text.startsWith("/")) return;

  if (!limiter.check(userId)) {
    return bot.sendMessage(chatId, "⚠️ Too many requests. Please slow down.");
  }

  const session = sessions.get(userId);
  if (!session) return;

  // ── Await amount input
  if (session.step === "AWAIT_AMOUNT") {
    const amount = sanitizeAmount(text);
    if (!amount) {
      return bot.sendMessage(chatId,
        "❌ Invalid amount. Please enter a positive number (e.g. `10` or `0.5`).",
        { parse_mode: "Markdown" }
      );
    }

    if (parseFloat(amount) > BOT_CONFIG.MAX_AMOUNT_USD) {
      return bot.sendMessage(chatId,
        `❌ Amount exceeds max cap of ${BOT_CONFIG.MAX_AMOUNT_USD}. ` +
        `For larger transfers, use the Across UI directly at https://app.across.to`
      );
    }

    sessions.update(userId, { amount, step: "AWAIT_RECIPIENT" });

    await bot.sendMessage(chatId,
      `✅ Amount: *${amount} ${session.token}*\n\nStep 5/5 — Enter your *recipient wallet address*:\n\n` +
      `_(The address that will receive funds on ${formatChainName(session.destinationChainId)})_`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Await recipient address
  else if (session.step === "AWAIT_RECIPIENT") {
    const address = sanitizeAddress(text);
    if (!address) {
      return bot.sendMessage(chatId,
        "❌ Invalid Ethereum address. Please enter a valid 0x... address."
      );
    }

    sessions.update(userId, { recipient: address, step: "FETCHING_QUOTE" });

    await bot.sendMessage(chatId, "⏳ Fetching live quote from Across Protocol...");

    try {
      await fetchAndShowQuote(chatId, userId, { ...session, recipient: address });
    } catch (err) {
      sessions.clear(userId);
      await bot.sendMessage(chatId,
        `❌ Failed to get quote: ${err.message}\n\nPlease try /bridge again.`
      );
    }
  }

  // ── Await status input (originChainId + depositId)
  else if (session.step === "AWAIT_STATUS_INPUT") {
    const parts = text.split(/\s+/);
    if (parts.length !== 2) {
      return bot.sendMessage(chatId,
        "❌ Please enter exactly two values: `originChainId depositId`\nExample: `10 12345`",
        { parse_mode: "Markdown" }
      );
    }

    const originChainId = sanitizeChainId(parts[0]);
    const depositId = parts[1].replace(/[^a-zA-Z0-9]/g, "");

    if (!originChainId || !depositId) {
      return bot.sendMessage(chatId, "❌ Invalid input. Please check your chain ID and deposit ID.");
    }

    await bot.sendMessage(chatId, "⏳ Checking deposit status...");

    try {
      const status = await across.getDepositStatus(originChainId, depositId);
      await bot.sendMessage(chatId,
        `📡 *Deposit Status*\n\n` +
        `Status: *${status.status}*\n` +
        (status.fillTxHash
          ? `Fill TX: ${formatTxLink(status.fillTxHash, status.destinationChainId)}`
          : "Fill TX: _Pending..._"),
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Status check failed: ${err.message}`);
    }

    sessions.clear(userId);
  }
});

// ─── QUOTE DISPLAY ─────────────────────────────────────────────────────────

async function fetchAndShowQuote(chatId, userId, session) {
  const token = SUPPORTED_TOKENS.find(t => t.symbol === session.token);
  if (!token) throw new Error("Unsupported token.");

  const inputToken = token.addresses[session.originChainId];
  const outputToken = token.addresses[session.destinationChainId];

  if (!inputToken || !outputToken) {
    throw new Error(`${session.token} is not available on one of the selected chains.`);
  }

  const quote = await across.getQuote({
    originChainId: session.originChainId,
    destinationChainId: session.destinationChainId,
    inputToken,
    outputToken,
    amount: session.amount,
    decimals: token.decimals,
    recipient: session.recipient,
  });

  // Store quote in session for confirmation step
  sessions.update(userId, {
    quote,
    step: "CONFIRM",
    quoteTimestamp: Date.now(),
  });

  const feeText = formatFees(quote.fees, session.token);

  await bot.sendMessage(chatId,
    `📋 *Bridge Quote*\n\n` +
    `From: *${formatChainName(session.originChainId)}*\n` +
    `To: *${formatChainName(session.destinationChainId)}*\n` +
    `Token: *${session.token}*\n` +
    `Amount: *${session.amount}*\n` +
    `You receive: *${quote.outputAmount} ${session.token}*\n` +
    `Recipient: \`${session.recipient}\`\n\n` +
    `${feeText}\n\n` +
    `⏱️ Estimated fill time: *~${quote.estimatedFillTime}*\n\n` +
    `⚠️ *Quote valid for ~10 minutes.* After confirming, sign the transaction in your wallet.\n\n` +
    `*Transaction Calldata (sign in your wallet):*\n\`\`\`\n${quote.calldata}\n\`\`\`\n\n` +
    `*To contract:* \`${quote.toContract}\`\n` +
    `*Value (ETH):* \`${quote.value || "0"}\``,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ I've signed & sent it", callback_data: "confirm_bridge" },
            { text: "❌ Cancel", callback_data: "cancel" },
          ],
        ],
      },
    }
  );
}

// ─── POST-CONFIRMATION (track status) ─────────────────────────────────────

async function executeBridge(chatId, userId, session) {
  // Quote expiry guard (10 min)
  const AGE_MS = Date.now() - session.quoteTimestamp;
  if (AGE_MS > 9 * 60 * 1000) {
    sessions.clear(userId);
    return bot.sendMessage(chatId,
      "⚠️ Quote has expired (>9 minutes old). Please start a new /bridge."
    );
  }

  await bot.sendMessage(chatId,
    `✅ *Confirmed!*\n\n` +
    `Once you've submitted the transaction in your wallet, use /status to track it.\n\n` +
    `You'll need:\n` +
    `• Origin Chain ID: \`${session.originChainId}\`\n` +
    `• Deposit ID: _(found in the \`V3FundsDeposited\` event in your wallet tx)_\n\n` +
    `Across fills typically settle in *2–10 seconds* on mainnet. 🚀`,
    { parse_mode: "Markdown" }
  );

  sessions.clear(userId);
}

// ─── ERROR HANDLING ────────────────────────────────────────────────────────

bot.on("polling_error", (err) => {
  console.error("[Bot polling error]", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled rejection]", reason);
});

console.log("🌉 Across Bridge Bot is running...");
