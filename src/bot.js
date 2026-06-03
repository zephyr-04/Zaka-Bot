require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { AcrossService } = require("./across");
const { SessionManager } = require("./session");
const { RateLimiter } = require("./rateLimiter");
const { sanitizeAddress, sanitizeAmount, sanitizeChainId } = require("./validators");
const { SUPPORTED_CHAINS, SUPPORTED_TOKENS, BOT_CONFIG } = require("../config/constants");
const { formatChainName } = require("./formatters");
const { explorerLink } = require("./walletLinks");
const { PrivyService } = require("./privy");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const across = new AcrossService();
const sessions = new SessionManager();
const privyService = new PrivyService();
const limiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  bridgeWindowMs: 300_000,
  maxBridges: 3,
});

// ─── /start — Email onboarding ─────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!limiter.check(userId)) return bot.sendMessage(chatId, "You're going too fast. Please wait a moment.");

  sessions.clear(userId);

  // Check if user already has a wallet
  const existing = sessions.getWallet(userId);
  if (existing) {
    return bot.sendMessage(chatId,
      `👋 Welcome back!\n\nYour wallet: \`${existing.walletAddress}\`\n\nUse /bridge to send tokens to another chain.`,
      { parse_mode: "Markdown" }
    );
  }

  sessions.set(userId, { step: "AWAIT_EMAIL" });

  await bot.sendMessage(chatId,
    `🌉 *Welcome to Zaka*\n\n` +
    `Zaka lets you send tokens from one blockchain to another — fast, cheap, and directly from Telegram.\n\n` +
    `To get started, enter your *email address* below.\n\n` +
    `We'll send you a quick verification code. No password needed.`,
    { parse_mode: "Markdown" }
  );
});

// ─── /wallet — Show current wallet ─────────────────────────────────────────

bot.onText(/\/wallet/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const wallet = sessions.getWallet(userId);

  if (!wallet) {
    return bot.sendMessage(chatId,
      "You don't have a wallet set up yet. Use /start to create one."
    );
  }

  await bot.sendMessage(chatId,
    `👛 *Your Wallet*\n\n` +
    `Address: \`${wallet.walletAddress}\`\n\n` +
    `_This is your Zaka wallet address. You can receive tokens here on any supported network._`,
    { parse_mode: "Markdown" }
  );
});

// ─── /bridge ───────────────────────────────────────────────────────────────

bot.onText(/\/bridge/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Must have wallet first
  const wallet = sessions.getWallet(userId);
  if (!wallet) {
    return bot.sendMessage(chatId,
      "You need to set up your wallet first. Use /start to get going."
    );
  }

  if (!limiter.checkBridge(userId)) {
    return bot.sendMessage(chatId, "You've made too many requests recently. Please wait a few minutes.");
  }

  sessions.clearFlow(userId);
  sessions.setFlow(userId, { step: "SELECT_ORIGIN_CHAIN" });

  const chainButtons = SUPPORTED_CHAINS.map(c => ([{ text: c.name, callback_data: `origin_chain:${c.id}` }]));
  await bot.sendMessage(chatId,
    `🔀 *New Transfer*\n\nStep 1 of 5 — Which network are your tokens on *right now*?`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: chainButtons } }
  );
});

// ─── /status ───────────────────────────────────────────────────────────────

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!limiter.check(userId)) return;
  sessions.clearFlow(userId);
  sessions.setFlow(userId, { step: "AWAIT_STATUS_INPUT" });
  await bot.sendMessage(chatId,
    `🔍 *Check Transfer Status*\n\n` +
    `Paste your transaction hash and the network you sent from:\n\n` +
    `Example: \`Ethereum 0x1234...abcd\`\n\n` +
    `_Find your transaction hash in your wallet's activity tab._`,
    { parse_mode: "Markdown" }
  );
});

// ─── /balance ──────────────────────────────────────────────────────────────

const { ethers } = require("ethers");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const CHAIN_RPC = {
  1:     process.env.RPC_ETHEREUM,
  10:    process.env.RPC_OPTIMISM,
  42161: process.env.RPC_ARBITRUM,
  8453:  process.env.RPC_BASE,
};

async function getWalletBalances(walletAddress) {
  const results = {};

  await Promise.allSettled(
    SUPPORTED_CHAINS.map(async (chain) => {
      const rpc = CHAIN_RPC[chain.id];
      if (!rpc) return;

      const provider = new ethers.JsonRpcProvider(rpc);
      const chainBalances = [];

      try {
        const raw = await provider.getBalance(walletAddress);
        const balance = parseFloat(ethers.formatEther(raw)).toFixed(4);
        chainBalances.push({ symbol: "ETH", balance });
      } catch (_) {}

      await Promise.allSettled(
        SUPPORTED_TOKENS.map(async (token) => {
          const tokenAddress = token.addresses?.[chain.id];
          if (!tokenAddress) return;
          try {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
            const [raw, decimals] = await Promise.all([
              contract.balanceOf(walletAddress),
              contract.decimals(),
            ]);
            const balance = parseFloat(ethers.formatUnits(raw, decimals)).toFixed(2);
            chainBalances.push({ symbol: token.symbol, balance });
          } catch (_) {}
        })
      );

      results[chain.name] = chainBalances;
    })
  );

  return results;
}

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!limiter.check(userId)) {
    return bot.sendMessage(chatId, "Too many requests. Please slow down.");
  }

  const wallet = sessions.getWallet(userId);
  if (!wallet) {
    return bot.sendMessage(chatId,
      "You don't have a wallet yet. Use /start to get set up."
    );
  }

  await bot.sendMessage(chatId, "⏳ Fetching your balances...");

  try {
    const balances = await getWalletBalances(wallet.walletAddress);

    const lines = [
      `💰 *Wallet Balance*`,
      `\`${wallet.walletAddress}\``,
      ``,
    ];

    for (const [chainName, chainBalances] of Object.entries(balances)) {
      const hasAny = chainBalances.some(b => parseFloat(b.balance) > 0);
      if (!hasAny) continue;

      lines.push(`*${chainName}*`);
      for (const { symbol, balance } of chainBalances) {
        if (parseFloat(balance) > 0) {
          lines.push(`  • ${symbol}: ${balance}`);
        }
      }
      lines.push(``);
    }

    if (lines.length === 3) {
      lines.push(`_No balances found on supported networks._`);
    }

    lines.push(`_Updated ${new Date().toLocaleTimeString()}_`);

    await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[balance error]", err.message);
    await bot.sendMessage(chatId,
      `⚠️ Couldn't fetch balances right now. Please try again.\n\n_${err.message}_`,
      { parse_mode: "Markdown" }
    );
  }
});

// ─── /tokens ───────────────────────────────────────────────────────────────

bot.onText(/\/tokens/, async (msg) => {
  const tokenList = SUPPORTED_TOKENS.map(t => `• *${t.symbol}* — ${t.name}`).join("\n");
  await bot.sendMessage(msg.chat.id,
    `🪙 *Supported Tokens*\n\n${tokenList}\n\n_More tokens coming soon._`,
    { parse_mode: "Markdown" }
  );
});

// ─── /help ─────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `❓ *How Zaka Works*\n\n` +
    `*What does Zaka do?*\n` +
    `Zaka moves your tokens from one blockchain to another — e.g. Ethereum to Arbitrum or Base to Optimism.\n\n` +
    `*Do I need a wallet app?*\n` +
    `No. Zaka creates a wallet for you using your email. No MetaMask, no seed phrases.\n\n` +
    `*How do I get started?*\n` +
    `Use /start, enter your email, verify with the code we send you. That's it — your wallet is ready.\n\n` +
    `*How long do transfers take?*\n` +
    `Most complete in 2–10 seconds.\n\n` +
    `*Is my money safe?*\n` +
    `Yes. Zaka uses Privy's bank-grade wallet infrastructure. Your keys are secured in hardware enclaves — neither Zaka nor Privy can access your funds without your authorization.\n\n` +
    `*Can I export my wallet?*\n` +
    `Yes. Contact support to export your private key at any time.\n\n` +
    `*Need help?* support@zaka.io`,
    { parse_mode: "Markdown" }
  );
});

// ─── CALLBACK QUERY HANDLER ────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (!limiter.check(userId)) return bot.answerCallbackQuery(query.id, { text: "Too many actions." });
  await bot.answerCallbackQuery(query.id);

  const session = sessions.getFlow(userId);
  if (!session) return bot.sendMessage(chatId, "Your session timed out. Please start again with /bridge.");

  // ── Select origin chain
  if (data.startsWith("origin_chain:") && session.step === "SELECT_ORIGIN_CHAIN") {
    const chainId = parseInt(data.split(":")[1]);
    const chain = SUPPORTED_CHAINS.find(c => c.id === chainId);
    if (!chain) return;
    sessions.updateFlow(userId, { originChainId: chainId, step: "SELECT_DEST_CHAIN" });
    const destChains = SUPPORTED_CHAINS.filter(c => c.id !== chainId).map(c => ([{ text: c.name, callback_data: `dest_chain:${c.id}` }]));
    await bot.sendMessage(chatId,
      `✅ Sending from: *${chain.name}*\n\nStep 2 of 5 — Which network should the tokens arrive on?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: destChains } }
    );
  }

  else if (data.startsWith("dest_chain:") && session.step === "SELECT_DEST_CHAIN") {
    const chainId = parseInt(data.split(":")[1]);
    const chain = SUPPORTED_CHAINS.find(c => c.id === chainId);
    if (!chain) return;
    sessions.updateFlow(userId, { destinationChainId: chainId, step: "SELECT_TOKEN" });
    const tokenButtons = SUPPORTED_TOKENS.map(t => ([{ text: `${t.symbol} — ${t.name}`, callback_data: `token:${t.symbol}` }]));
    await bot.sendMessage(chatId,
      `✅ Arriving on: *${chain.name}*\n\nStep 3 of 5 — Which token do you want to send?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: tokenButtons } }
    );
  }

  else if (data.startsWith("token:") && session.step === "SELECT_TOKEN") {
    const symbol = data.split(":")[1];
    sessions.updateFlow(userId, { token: symbol, step: "AWAIT_AMOUNT" });
    await bot.sendMessage(chatId,
      `✅ Token: *${symbol}*\n\nStep 4 of 5 — How much do you want to send?\n\nType the number, e.g. \`10\` or \`0.5\`\n\n_Min: $${BOT_CONFIG.MIN_AMOUNT_USD} — Max: $${BOT_CONFIG.MAX_AMOUNT_USD}_`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Confirm bridge
  else if (data === "confirm_bridge" && session.step === "CONFIRM") {
    await executeBridge(chatId, userId, session);
  }

  // ── Cancel
  else if (data === "cancel") {
    sessions.clearFlow(userId);
    await bot.sendMessage(chatId, "Transfer cancelled. Tap /bridge whenever you're ready.");
  }
});

// ─── TEXT MESSAGE HANDLER ──────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith("/")) return;
  if (!limiter.check(userId)) return bot.sendMessage(chatId, "Too many requests. Please slow down.");

  const session = sessions.getFlow(userId);
  if (!session) return;

  // ── Email input
  if (session.step === "AWAIT_EMAIL") {
    const email = text.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return bot.sendMessage(chatId,
        "That doesn't look like a valid email address. Please try again."
      );
    }

    sessions.updateFlow(userId, { email, step: "AWAIT_OTP" });
    await bot.sendMessage(chatId, "Sending your verification code...");

    try {
      await privyService.sendEmailOTP(email);
      await bot.sendMessage(chatId,
        `📧 We sent a 6-digit code to *${email}*\n\nEnter it below to verify your account.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId,
        `Couldn't send the code. Please check your email and try /start again.\n\n_${err.message}_`,
        { parse_mode: "Markdown" }
      );
    }
  }

  // ── OTP input
  else if (session.step === "AWAIT_OTP") {
    const code = text.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      return bot.sendMessage(chatId,
        "The code should be 6 digits. Please check your email and try again."
      );
    }

    await bot.sendMessage(chatId, "Verifying...");

    try {
      const { privyUserId, walletAddress, walletId } = await privyService.verifyEmailOTP(session.email, code);

sessions.storeWallet(userId, { privyUserId, walletAddress, walletId });
sessions.clearFlow(userId);

if (walletAddress) {
  await bot.sendMessage(chatId,
    `✅ *You're all set!*\n\n` +
    `Your wallet has been created:\n\`${walletAddress}\`\n\n` +
    `Ready to bridge? Use /bridge to send tokens to another chain.`,
    { parse_mode: "Markdown" }
  );
} else {
  await bot.sendMessage(chatId,
    `✅ *Verified!*\n\n` +
    `Your account is set up. Setting up your wallet now — use /wallet to check when it's ready.`,
    { parse_mode: "Markdown" }
  );
}
    } catch (err) {
      await bot.sendMessage(chatId,
        `That code didn't work. Please check your email and try again, or use /start to resend.`
      );
    }
  }

  // ── Amount input
  else if (session.step === "AWAIT_AMOUNT") {
    const amount = sanitizeAmount(text);
    if (!amount) return bot.sendMessage(chatId, "Please enter a valid number like `10` or `0.5`.", { parse_mode: "Markdown" });
    if (parseFloat(amount) > BOT_CONFIG.MAX_AMOUNT_USD) {
      return bot.sendMessage(chatId, `The maximum per transfer is $${BOT_CONFIG.MAX_AMOUNT_USD}. For larger amounts, contact support.`);
    }
    sessions.updateFlow(userId, { amount, step: "AWAIT_RECIPIENT" });
    await bot.sendMessage(chatId,
      `✅ Amount: *${amount} ${session.token}*\n\nStep 5 of 5 — What wallet address should receive the tokens on *${formatChainName(session.destinationChainId)}*?\n\nPaste the receiving address (starts with \`0x\`).`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Recipient input
  else if (session.step === "AWAIT_RECIPIENT") {
    const address = sanitizeAddress(text);
    if (!address) {
      return bot.sendMessage(chatId,
        `That doesn't look like a valid wallet address. It should start with \`0x\` and be 42 characters long. Please try again.`,
        { parse_mode: "Markdown" }
      );
    }
    sessions.updateFlow(userId, { recipient: address, step: "FETCHING_QUOTE" });
    await bot.sendMessage(chatId, "Getting your quote...");
    try {
      await fetchAndShowQuote(chatId, userId, { ...sessions.getFlow(userId) });
    } catch (err) {
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId,
        `Something went wrong getting your quote. Please try /bridge again.\n\n_${err.message}_`,
        { parse_mode: "Markdown" }
      );
    }
  }

  // ── Status check
  else if (session.step === "AWAIT_STATUS_INPUT") {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      return bot.sendMessage(chatId,
        `Please include both the network name and your transaction hash.\n\nExample: \`Ethereum 0x1234...abcd\``,
        { parse_mode: "Markdown" }
      );
    }

    const networkName = parts[0];
    const txHash = parts[1];
    const chain = SUPPORTED_CHAINS.find(c => c.name.toLowerCase() === networkName.toLowerCase());

    if (!chain) {
      return bot.sendMessage(chatId,
        `Couldn't recognise that network. Supported: ${SUPPORTED_CHAINS.map(c => c.name).join(", ")}`
      );
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return bot.sendMessage(chatId,
        `That transaction hash doesn't look right. Find it in your wallet's activity tab.`
      );
    }

    const link = explorerLink(txHash, chain.id);
    await bot.sendMessage(chatId,
      `📡 *Transfer Lookup*\n\nNetwork: *${chain.name}*\n[View on block explorer](${link})\n\n_If your tokens haven't arrived after 2 minutes, visit the Across Discord for support._`,
      { parse_mode: "Markdown" }
    );
    sessions.clearFlow(userId);
  }
});

// ─── FETCH AND SHOW QUOTE ──────────────────────────────────────────────────

async function fetchAndShowQuote(chatId, userId, session) {
  const token = SUPPORTED_TOKENS.find(t => t.symbol === session.token);
  if (!token) throw new Error("That token isn't supported yet.");

  const inputToken = token.addresses[session.originChainId];
  const outputToken = token.addresses[session.destinationChainId];
  if (!inputToken || !outputToken) {
    throw new Error(`${session.token} isn't available on one of the selected networks.`);
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

  if (quote.isAmountTooLow) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "The amount is too small for this transfer. Please try a larger amount.");
  }

  sessions.updateFlow(userId, { quote, quoteTimestamp: Date.now(), step: "CONFIRM" });

  const feeText = quote.fees?.totalFeeAmount
    ? `~${parseFloat(quote.fees.totalFeeAmount).toFixed(6)} ${session.token}`
    : "included in output amount";

  // Check if approval needed
  const approvalNote = quote.approvalTxns?.length > 0
    ? `\n⚠️ _This token requires a one-time approval. Zaka will handle it automatically before sending._\n`
    : "";

  await bot.sendMessage(chatId,
    `📋 *Your Transfer Summary*\n\n` +
    `From: *${formatChainName(session.originChainId)}*\n` +
    `To: *${formatChainName(session.destinationChainId)}*\n` +
    `Token: *${session.token}*\n` +
    `You send: *${session.amount} ${session.token}*\n` +
    `Recipient gets: *${quote.outputAmount} ${session.token}*\n` +
    `Receiving address: \`${session.recipient}\`\n` +
    `Network fee: ${feeText}\n` +
    `Expected arrival: *${quote.estimatedFillTime}*\n` +
    `${approvalNote}\n` +
    `Tap *Confirm* to send — Zaka will sign and submit the transaction for you.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm Transfer", callback_data: "confirm_bridge" },
            { text: "❌ Cancel", callback_data: "cancel" },
          ],
        ],
      },
    }
  );
}

// ─── EXECUTE BRIDGE ────────────────────────────────────────────────────────

async function executeBridge(chatId, userId, session) {
  // Quote expiry guard
  if (Date.now() - session.quoteTimestamp > BOT_CONFIG.QUOTE_EXPIRY_MS) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "Your quote expired. Please start a new transfer with /bridge.");
  }

  const wallet = sessions.getWallet(userId);
  if (!wallet) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "Wallet not found. Please use /start to set up your wallet.");
  }

  await bot.sendMessage(chatId, "⏳ Submitting your transfer...");

  try {
    const { quote } = session;

    // Get Privy wallet ID from user ID
    const walletId = wallet.walletId;
if (!walletId) throw new Error("Wallet not found. Please use /start to re-authenticate.");

    // Handle approval tx first if needed
    if (quote.approvalTxns?.length > 0) {
      await bot.sendMessage(chatId, "Approving token spend...");
      const approvalTx = quote.approvalTxns[0];
      await privyService.sendTransaction(walletId, {
        to: approvalTx.to,
        data: approvalTx.data,
        value: "0",
        chainId: approvalTx.chainId,
      });
      await bot.sendMessage(chatId, "✅ Approval done. Sending bridge transaction...");
    }

    // Send bridge transaction
    const txHash = await privyService.sendTransaction(walletId, {
      to: quote.toContract,
      data: quote.calldata,
      value: quote.value,
      chainId: session.originChainId,
    });

    const link = txHash ? explorerLink(txHash, session.originChainId) : null;

    sessions.clearFlow(userId);

    await bot.sendMessage(chatId,
      `✅ *Transfer submitted!*\n\n` +
      `Your tokens are on their way to *${formatChainName(session.destinationChainId)}*.\n` +
      `They should arrive in *${quote.estimatedFillTime}*.\n\n` +
      (link ? `[View transaction](${link})\n\n` : "") +
      `Check your balance on ${formatChainName(session.destinationChainId)} to confirm arrival.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    sessions.clearFlow(userId);
    await bot.sendMessage(chatId,
      `❌ Transfer failed: ${err.message}\n\nPlease try /bridge again.`
    );
  }
}

// ─── ERROR HANDLING ────────────────────────────────────────────────────────

bot.on("polling_error", (err) => console.error("[polling error]", err.message));
process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason));

bot.setMyCommands([
  { command: "start", description: "Set up your wallet" },
  { command: "bridge", description: "Send tokens to another chain" },
  { command: "wallet", description: "View your wallet address" },
  { command: "status", description: "Check if your transfer arrived" },
  { command: "balance", description: "Check your wallet balances" },
  { command: "tokens", description: "See supported tokens" },
  { command: "help", description: "How Zaka works" },
  
]);

console.log("Zaka Bridge Bot is running...");