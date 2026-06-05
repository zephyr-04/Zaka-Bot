require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { AcrossService } = require("./across").default;
const { SessionManager } = require("./session");
const { RateLimiter } = require("./rateLimiter");
const { sanitizeAddress, sanitizeAmount } = require("./validators");
const { SUPPORTED_CHAINS, SUPPORTED_TOKENS, BOT_CONFIG } = require("../config/constants");
const { formatChainName } = require("./formatters");
const { explorerLink } = require("./walletLinks");
const { PrivyService } = require("./privy");
const {
  isPrivateChat,
  validateEVMPrivateKey,
  validateSolanaPrivateKey,
  wipeKey,
  deleteMessage,
} = require("./security");

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

// ─── SECURITY: Block sensitive commands in group chats ─────────────────────

const SENSITIVE_COMMANDS = ["/importwallet", "/exportwallet", "/start"];

bot.on("message", async (msg) => {
  const text = msg.text?.trim() || "";
  const isSensitive = SENSITIVE_COMMANDS.some(cmd => text.startsWith(cmd));

  if (isSensitive && !isPrivateChat(msg)) {
    await bot.sendMessage(msg.chat.id,
      "⚠️ For your security, wallet commands can only be used in private chats with Zaka.\n\nTap @ZakaBot to open a private chat."
    );
    return;
  }
});

// ─── /start ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!limiter.check(userId)) return bot.sendMessage(chatId, "You're going too fast. Please wait a moment.");

  sessions.clearFlow(userId);

  const existing = sessions.getWallet(userId);
  if (existing) {
    return bot.sendMessage(chatId,
      `👋 *Welcome back!*\n\n` +
      `Your wallet: \`${existing.walletAddress}\`\n\n` +
      `What would you like to do?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: " Bridge tokens", callback_data: "goto_bridge" }],
            [{ text: " View wallet & balance", callback_data: "goto_wallet" }],
            [{ text: "📥 Import another wallet", callback_data: "goto_import" }],
          ],
        },
      }
    );
  }

  sessions.setFlow(userId, { step: "AWAIT_EMAIL" });

  await bot.sendMessage(chatId,
    `🌉 *Welcome to Zaka*\n\n` +
    `Zaka lets you bridge tokens across blockchains — fast, cheap, and directly from Telegram.\n\n` +
    `To get started, enter your *email address* below. We'll send you a verification code.\n\n` +
    `_Already have a wallet? Use /importwallet to bring it in._`,
    { parse_mode: "Markdown" }
  );
});

// ─── /wallet ───────────────────────────────────────────────────────────────

bot.onText(/\/wallet/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!limiter.check(userId)) return;

  const wallet = sessions.getWallet(userId);
  if (!wallet) {
    return bot.sendMessage(chatId, "You don't have a wallet yet. Use /start to create one.");
  }

  await bot.sendMessage(chatId, "⏳ Fetching your balances...");

  try {
    const balances = await privyService.getEVMBalances(wallet.walletAddress);

    let balanceText = "";
    if (balances.length === 0) {
      balanceText = "_No balances found. Fund your wallet to get started._";
    } else {
      balanceText = balances.map(b => `• *${b.symbol}* on ${b.chain}: \`${b.balance}\``).join("\n");
    }

    await bot.sendMessage(chatId,
      `👛 *Your Wallet*\n\n` +
      `Address: \`${wallet.walletAddress}\`\n\n` +
      `*Balances:*\n${balanceText}\n\n` +
      `_To receive tokens, share your address above._`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: " Bridge tokens", callback_data: "goto_bridge" }],
            [{ text: "📤 Export wallet", callback_data: "goto_export" }],
            [{ text: "📥 Import wallet", callback_data: "goto_import" }],
          ],
        },
      }
    );
  } catch (err) {
    await bot.sendMessage(chatId,
      ` *Your Wallet*\n\nAddress: \`${wallet.walletAddress}\`\n\n_Could not fetch balances right now. Try again shortly._`,
      { parse_mode: "Markdown" }
    );
  }
});

// ─── /importwallet ─────────────────────────────────────────────────────────

bot.onText(/\/importwallet/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!limiter.check(userId)) return;

  sessions.clearFlow(userId);
  sessions.setFlow(userId, { step: "AWAIT_IMPORT_TYPE" });

  await bot.sendMessage(chatId,
    `📥 *Import Wallet*\n\n` +
    `Which type of wallet do you want to import?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: " EVM (MetaMask, Rabby, etc)", callback_data: "import_type:evm" }],
          [{ text: " Solana (Phantom, Backpack, etc)", callback_data: "import_type:solana" }],
          [{ text: " Cancel", callback_data: "cancel" }],
        ],
      },
    }
  );
});

// ─── /exportwallet ─────────────────────────────────────────────────────────

bot.onText(/\/exportwallet/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!limiter.check(userId)) return;

  const wallet = sessions.getWallet(userId);
  if (!wallet) {
    return bot.sendMessage(chatId, "You don't have a wallet to export. Use /start to create one.");
  }

  if (!wallet.walletId) {
    return bot.sendMessage(chatId, "This wallet cannot be exported. Only Zaka-created wallets support export.");
  }

  await bot.sendMessage(chatId,
    `⚠️ *Warning — Export Wallet*\n\n` +
    `Your private key gives *complete access* to your funds.\n\n` +
    `• Never share it with anyone\n` +
    `• Store it somewhere safe and offline\n` +
    `• Zaka will delete this message after 30 seconds\n\n` +
    `Are you sure you want to export?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, export my key", callback_data: "confirm_export" }],
          [{ text: "❌ Cancel", callback_data: "cancel" }],
        ],
      },
    }
  );
});

// ─── /removewallet ─────────────────────────────────────────────────────────

bot.onText(/\/removewallet/, async (msg) => {
  if (!isPrivateChat(msg)) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const wallet = sessions.getWallet(userId);
  if (!wallet) return bot.sendMessage(chatId, "No wallet to remove.");

  await bot.sendMessage(chatId,
    `⚠️ *Remove Wallet*\n\n` +
    `This will disconnect \`${wallet.walletAddress}\` from Zaka.\n\n` +
    `Your funds are safe — this only removes the connection. You can re-import anytime.\n\n` +
    `Are you sure?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, remove it", callback_data: "confirm_remove_wallet" }],
          [{ text: "❌ Cancel", callback_data: "cancel" }],
        ],
      },
    }
  );
});

// ─── /bridge ───────────────────────────────────────────────────────────────

bot.onText(/\/bridge/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const wallet = sessions.getWallet(userId);
  if (!wallet) return bot.sendMessage(chatId, "You need a wallet first. Use /start to get going.");
  if (!limiter.checkBridge(userId)) return bot.sendMessage(chatId, "Too many requests. Please wait a few minutes.");

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
    `🔍 *Check Transfer Status*\n\nPaste your transaction hash and network:\n\nExample: \`Ethereum 0x1234...abcd\``,
    { parse_mode: "Markdown" }
  );
});

// ─── /tokens & /help ───────────────────────────────────────────────────────

bot.onText(/\/tokens/, async (msg) => {
  const tokenList = SUPPORTED_TOKENS.map(t => `• *${t.symbol}* — ${t.name}`).join("\n");
  await bot.sendMessage(msg.chat.id, `🪙 *Supported Tokens*\n\n${tokenList}`, { parse_mode: "Markdown" });
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `❓ *How Zaka Works*\n\n` +
    `*Bridge tokens* across blockchains with /bridge\n` +
    `*View wallet & balances* with /wallet\n` +
    `*Import an existing wallet* with /importwallet\n` +
    `*Export your wallet key* with /exportwallet\n` +
    `*Remove wallet from Zaka* with /removewallet\n\n` +
    `*Is my money safe?*\n` +
    `Yes. Keys are secured in Privy's hardware enclaves (TEEs). Not even Privy can access them without your authorization.\n\n` +
    `*Support:* https://discord.across.to`,
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

  // ── Navigation shortcuts
  if (data === "goto_bridge") return bot.sendMessage(chatId, "Use /bridge to start a transfer.");
  if (data === "goto_wallet") return bot.sendMessage(chatId, "Use /wallet to view your wallet and balances.");
  if (data === "goto_import") return bot.sendMessage(chatId, "Use /importwallet to import a wallet.");
  if (data === "goto_export") return bot.sendMessage(chatId, "Use /exportwallet to export your wallet.");

  // ── Import type selection
  if (data === "import_type:evm") {
    sessions.updateFlow(userId, { step: "AWAIT_EVM_KEY", importType: "evm" });
    await bot.sendMessage(chatId,
      `🔷 *Import EVM Wallet*\n\n` +
      `⚠️ *Security notice:*\n` +
      `• Make sure you are in a *private chat* with Zaka\n` +
      `• Your message will be *deleted immediately*\n` +
      `• Your key goes straight into a secure enclave — Zaka never stores it\n\n` +
      `Paste your *private key* below (64 hex characters, with or without 0x):`,
      { parse_mode: "Markdown" }
    );
  }

  else if (data === "import_type:solana") {
    sessions.updateFlow(userId, { step: "AWAIT_SOLANA_KEY", importType: "solana" });
    await bot.sendMessage(chatId,
      `🟣 *Import Solana Wallet*\n\n` +
      `⚠️ *Security notice:*\n` +
      `• Make sure you are in a *private chat* with Zaka\n` +
      `• Your message will be *deleted immediately*\n` +
      `• Your key goes straight into a secure enclave\n\n` +
      `Paste your *private key* below (base58 encoded):`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Export confirmation
  else if (data === "confirm_export") {
    const wallet = sessions.getWallet(userId);
    if (!wallet?.walletId) return bot.sendMessage(chatId, "Wallet not found.");

    await bot.sendMessage(chatId, "⏳ Retrieving your key from secure enclave...");

    try {
      const privateKey = await privyService.exportWallet(wallet.walletId);
      if (!privateKey) throw new Error("Key not available.");

      // Send key — this is the ONLY time it's ever shown
      const keyMsg = await bot.sendMessage(chatId,
        `🔑 *Your Private Key*\n\n` +
        `\`${privateKey}\`\n\n` +
        `⚠️ *Copy this now.* This message will be deleted in 30 seconds.\n` +
        `Never share this with anyone.`,
        { parse_mode: "Markdown" }
      );

      // Auto-delete after 30 seconds
      setTimeout(async () => {
        await deleteMessage(bot, chatId, keyMsg.message_id);
        await bot.sendMessage(chatId, "🗑️ Your private key message has been deleted for security.");
      }, 30_000);

    } catch (err) {
      await bot.sendMessage(chatId, `Could not export wallet: ${err.message}`);
    }
  }

  // ── Remove wallet confirmation
  else if (data === "confirm_remove_wallet") {
    sessions.clearWallet(userId);
    sessions.clearFlow(userId);
    await bot.sendMessage(chatId,
      `✅ Wallet removed from Zaka.\n\nYour funds are safe. Use /start or /importwallet anytime to reconnect.`
    );
  }

  // ── Bridge flow
  const session = sessions.getFlow(userId);
  if (!session) return;

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
      `✅ Token: *${symbol}*\n\nStep 4 of 5 — How much do you want to send?\n\nType the number e.g. \`10\` or \`0.5\`\n\n_Min: $${BOT_CONFIG.MIN_AMOUNT_USD} — Max: $${BOT_CONFIG.MAX_AMOUNT_USD}_`,
      { parse_mode: "Markdown" }
    );
  }

  else if (data === "confirm_bridge" && session.step === "CONFIRM") {
    await executeBridge(chatId, userId, session);
  }

  else if (data === "cancel") {
    sessions.clearFlow(userId);
    await bot.sendMessage(chatId, "Cancelled. Use /bridge to start again.");
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

  // ── EVM private key input
  if (session.step === "AWAIT_EVM_KEY") {
    // Delete message immediately — before any processing
    await deleteMessage(bot, chatId, msg.message_id);

    if (!isPrivateChat(msg)) {
      return bot.sendMessage(chatId, "⚠️ Private keys can only be submitted in private chats.");
    }

    let key = text;
    const derivedAddress = validateEVMPrivateKey(key);

    if (!derivedAddress) {
      key = wipeKey(key);
      sessions.clearFlow(userId);
      return bot.sendMessage(chatId,
        "❌ That doesn't look like a valid EVM private key. It should be 64 hex characters.\n\nUse /importwallet to try again."
      );
    }

    await bot.sendMessage(chatId, "⏳ Importing your wallet securely...");

    try {
      // Get or create Privy user for this Telegram ID
      let privyUserId = sessions.getWallet(userId)?.privyUserId;
      if (!privyUserId) {
        privyUserId = await privyService.getUserOrCreate(userId);
      }

      const { walletId, walletAddress } = await privyService.importEVMWallet(key, privyUserId);
      key = wipeKey(key); // Wipe immediately after use

      sessions.storeWallet(userId, { privyUserId, walletAddress, walletId, type: "evm" });
      sessions.clearFlow(userId);

      await bot.sendMessage(chatId,
        `✅ *EVM Wallet Imported!*\n\n` +
        `Address: \`${walletAddress}\`\n\n` +
        `Your wallet is now secured in Privy's hardware enclave. The private key has been wiped from memory.\n\n` +
        `Use /bridge to start transferring tokens.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      key = wipeKey(key);
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId, `❌ Import failed. Please check your key and try /importwallet again.`);
    }
    return;
  }

  // ── Solana private key input
  if (session.step === "AWAIT_SOLANA_KEY") {
    await deleteMessage(bot, chatId, msg.message_id);

    if (!isPrivateChat(msg)) {
      return bot.sendMessage(chatId, "⚠️ Private keys can only be submitted in private chats.");
    }

    let key = text;
    const isValid = validateSolanaPrivateKey(key);

    if (!isValid) {
      key = wipeKey(key);
      sessions.clearFlow(userId);
      return bot.sendMessage(chatId,
        "❌ That doesn't look like a valid Solana private key. It should be a base58 encoded string.\n\nUse /importwallet to try again."
      );
    }

    await bot.sendMessage(chatId, "⏳ Importing your Solana wallet securely...");

    try {
      let privyUserId = sessions.getWallet(userId)?.privyUserId;
      if (!privyUserId) {
        privyUserId = await privyService.getUserOrCreate(userId);
      }

      const { walletId, walletAddress } = await privyService.importSolanaWallet(key, privyUserId);
      key = wipeKey(key);

      sessions.storeWallet(userId, { privyUserId, walletAddress, walletId, type: "solana" });
      sessions.clearFlow(userId);

      await bot.sendMessage(chatId,
        `✅ *Solana Wallet Imported!*\n\n` +
        `Address: \`${walletAddress}\`\n\n` +
        `Your wallet is secured in Privy's hardware enclave.\n\n` +
        `Use /bridge to start transferring tokens.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      key = wipeKey(key);
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId, `❌ Import failed. Please check your key and try /importwallet again.`);
    }
    return;
  }

  // ── Email input
  if (session.step === "AWAIT_EMAIL") {
    const email = text.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return bot.sendMessage(chatId, "That doesn't look like a valid email. Please try again.");
    }
    sessions.updateFlow(userId, { email, step: "AWAIT_OTP" });
    await bot.sendMessage(chatId, "Sending your verification code...");
    try {
      await privyService.sendEmailOTP(email);
      await bot.sendMessage(chatId,
        `📧 Code sent to *${email}*\n\nEnter the 6-digit code below:`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId, `Couldn't send the code. Please try /start again.`);
    }
  }

  // ── OTP input
  else if (session.step === "AWAIT_OTP") {
    const code = text.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      return bot.sendMessage(chatId, "The code should be 6 digits. Please check your email and try again.");
    }
    await bot.sendMessage(chatId, "Verifying...");
    try {
      const { privyUserId, walletAddress, walletId } = await privyService.verifyEmailOTP(session.email, code);
      sessions.storeWallet(userId, { privyUserId, walletAddress, walletId, type: "evm" });
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId,
        `✅ *You're all set!*\n\n` +
        `Your wallet: \`${walletAddress}\`\n\n` +
        `Use /bridge to send tokens, or /wallet to check your balances.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await bot.sendMessage(chatId, "That code didn't work. Please check your email and try again, or use /start to resend.");
    }
  }

  // ── Amount input
  else if (session.step === "AWAIT_AMOUNT") {
    const amount = sanitizeAmount(text);
    if (!amount) return bot.sendMessage(chatId, "Please enter a valid number like `10` or `0.5`.", { parse_mode: "Markdown" });
    if (parseFloat(amount) > BOT_CONFIG.MAX_AMOUNT_USD) return bot.sendMessage(chatId, `Max transfer is $${BOT_CONFIG.MAX_AMOUNT_USD}.`);
    sessions.updateFlow(userId, { amount, step: "AWAIT_RECIPIENT" });
    await bot.sendMessage(chatId,
      `✅ Amount: *${amount} ${session.token}*\n\nStep 5 of 5 — Paste the *receiving address* on *${formatChainName(session.destinationChainId)}*:`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Recipient input
  else if (session.step === "AWAIT_RECIPIENT") {
    const address = sanitizeAddress(text);
    if (!address) return bot.sendMessage(chatId, "Invalid address. Should start with `0x` and be 42 characters.", { parse_mode: "Markdown" });
    sessions.updateFlow(userId, { recipient: address, step: "FETCHING_QUOTE" });
    await bot.sendMessage(chatId, "Getting your quote...");
    try {
      await fetchAndShowQuote(chatId, userId, { ...sessions.getFlow(userId) });
    } catch (err) {
      sessions.clearFlow(userId);
      await bot.sendMessage(chatId, `Something went wrong. Please try /bridge again.`);
    }
  }

  // ── Status check
  else if (session.step === "AWAIT_STATUS_INPUT") {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return bot.sendMessage(chatId, "Include network and tx hash. Example: `Ethereum 0x1234...`", { parse_mode: "Markdown" });
    const chain = SUPPORTED_CHAINS.find(c => c.name.toLowerCase() === parts[0].toLowerCase());
    if (!chain) return bot.sendMessage(chatId, `Unknown network. Supported: ${SUPPORTED_CHAINS.map(c => c.name).join(", ")}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(parts[1])) return bot.sendMessage(chatId, "That tx hash doesn't look right.");
    const link = explorerLink(parts[1], chain.id);
    await bot.sendMessage(chatId, `📡 *Transfer Lookup*\n\nNetwork: *${chain.name}*\n[View on block explorer](${link})`, { parse_mode: "Markdown" });
    sessions.clearFlow(userId);
  }
});

// ─── FETCH AND SHOW QUOTE ──────────────────────────────────────────────────

async function fetchAndShowQuote(chatId, userId, session) {
  const token = SUPPORTED_TOKENS.find(t => t.symbol === session.token);
  if (!token) throw new Error("Token not supported.");
  const inputToken = token.addresses[session.originChainId];
  const outputToken = token.addresses[session.destinationChainId];
  if (!inputToken || !outputToken) throw new Error(`${session.token} not available on selected networks.`);

  const senderWallet = sessions.getWallet(userId);
const quote = await across.getQuote({
  originChainId: session.originChainId,
  destinationChainId: session.destinationChainId,
  inputToken, outputToken,
  amount: session.amount,
  decimals: token.decimals,
  recipient: session.recipient,   // where tokens arrive
  depositor: senderWallet?.walletAddress, // who is sending
});

  if (quote.isAmountTooLow) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "Amount too small. Please try a larger amount.");
  }

  sessions.updateFlow(userId, { quote, quoteTimestamp: Date.now(), step: "CONFIRM" });

  const feeText = quote.fees?.totalFeeAmount
    ? `~${parseFloat(quote.fees.totalFeeAmount).toFixed(6)} ${session.token}`
    : "included in output";

  const approvalNote = quote.approvalTxns?.length > 0
    ? `\n⚠️ _One-time token approval required — Zaka handles it automatically._\n`
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
    `Tap *Confirm* to send:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Confirm Transfer", callback_data: "confirm_bridge" },
          { text: "❌ Cancel", callback_data: "cancel" },
        ]],
      },
    }
  );
}

// ─── EXECUTE BRIDGE ────────────────────────────────────────────────────────

async function executeBridge(chatId, userId, session) {
  if (Date.now() - session.quoteTimestamp > BOT_CONFIG.QUOTE_EXPIRY_MS) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "Quote expired. Please start a new /bridge.");
  }

  const wallet = sessions.getWallet(userId);
  if (!wallet) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "Wallet not found. Please use /start.");
  }

  const walletId = wallet.walletId;
  if (!walletId) {
    sessions.clearFlow(userId);
    return bot.sendMessage(chatId, "Wallet not configured for signing. Please re-import with /importwallet.");
  }

  await bot.sendMessage(chatId, "⏳ Submitting your transfer...");

  try {
    const { quote } = session;

    if (quote.approvalTxns?.length > 0) {
      await bot.sendMessage(chatId, "Approving token spend...");
      const approvalTx = quote.approvalTxns[0];
      await privyService.sendTransaction(walletId, {
        to: approvalTx.to, data: approvalTx.data, value: "0", chainId: approvalTx.chainId,
      });
      await bot.sendMessage(chatId, "✅ Approved. Sending bridge transaction...");
    }

    const txHash = await privyService.sendTransaction(walletId, {
      to: quote.toContract, data: quote.calldata, value: quote.value, chainId: session.originChainId,
    });

    const link = txHash ? explorerLink(txHash, session.originChainId) : null;
    sessions.clearFlow(userId);

    await bot.sendMessage(chatId,
      `✅ *Transfer submitted!*\n\n` +
      `Heading to *${formatChainName(session.destinationChainId)}*.\n` +
      `Expected arrival: *${quote.estimatedFillTime}*\n\n` +
      (link ? `[View transaction](${link})\n\n` : "") +
      `Check /wallet to confirm arrival.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    sessions.clearFlow(userId);
    await bot.sendMessage(chatId, `❌ Transfer failed. Please try /bridge again.`);
  }
}

// ─── ERROR HANDLING ────────────────────────────────────────────────────────

bot.on("polling_error", (err) => console.error("[polling error]", err.message));
process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason));

bot.setMyCommands([
  { command: "start", description: "Set up or access your wallet" },
  { command: "bridge", description: "Send tokens to another chain" },
  { command: "wallet", description: "View wallet address and balances" },
  { command: "importwallet", description: "Import an existing wallet" },
  { command: "exportwallet", description: "Export your private key" },
  { command: "removewallet", description: "Disconnect wallet from Zaka" },
  { command: "status", description: "Check a transfer status" },
  { command: "tokens", description: "See supported tokens" },
  { command: "help", description: "How Zaka works" },
]);

console.log("Zaka Bridge Bot is running...");