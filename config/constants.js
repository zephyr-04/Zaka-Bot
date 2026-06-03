const SUPPORTED_CHAINS = [
  { id: 1,      name: "Ethereum" },
  { id: 10,     name: "Optimism" },
  { id: 137,    name: "Polygon" },
  { id: 8453,   name: "Base" },
  { id: 42161,  name: "Arbitrum" },
  { id: 324,    name: "zkSync Era" },
  { id: 59144,  name: "Linea" },
];

const SUPPORTED_TOKENS = [
  {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    addresses: {
      1:      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      10:     "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      137:    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      8453:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      42161:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      324:    "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
      59144:  "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    },
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    addresses: {
      1:      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      10:     "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      137:    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      8453:   "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      42161:  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 18,
    addresses: {
      1:      "0x0000000000000000000000000000000000000000",
      10:     "0x0000000000000000000000000000000000000000",
      8453:   "0x0000000000000000000000000000000000000000",
      42161:  "0x0000000000000000000000000000000000000000",
      324:    "0x0000000000000000000000000000000000000000",
      59144:  "0x0000000000000000000000000000000000000000",
    },
  },
  {
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    addresses: {
      1:      "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      10:     "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      137:    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      8453:   "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      42161:  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    },
  },
];

const EXPLORER_URLS = {
  1:      "https://etherscan.io",
  10:     "https://optimistic.etherscan.io",
  137:    "https://polygonscan.com",
  8453:   "https://basescan.org",
  42161:  "https://arbiscan.io",
  324:    "https://explorer.zksync.io",
  59144:  "https://lineascan.build",
};

// ─── TESTNET ──────────────────────────────────────────────────────────────────

const TESTNET_CHAINS = [
  { id: 11155111, name: "Sepolia" },
  { id: 84532,    name: "Base Sepolia" },
];

const TESTNET_TOKENS = [
  {
    symbol: "USDC",
    name: "USD Coin (Testnet)",
    decimals: 6,
    addresses: {
      11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      84532:    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
  },
  {
    symbol: "ETH",
    name: "Ethereum (Testnet)",
    decimals: 18,
    addresses: {
      11155111: "0x0000000000000000000000000000000000000000",
      84532:    "0x0000000000000000000000000000000000000000",
    },
  },
];

const TESTNET_EXPLORER_URLS = {
  11155111: "https://sepolia.etherscan.io",
  84532:    "https://sepolia.basescan.org",
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BOT_CONFIG = {
  MIN_AMOUNT_USD: 5,
  MAX_AMOUNT_USD: 50000,
  QUOTE_EXPIRY_MS: 9 * 60 * 1000,
};

const IS_TESTNET = process.env.TESTNET === "true";

module.exports = {
  SUPPORTED_CHAINS: IS_TESTNET ? TESTNET_CHAINS : SUPPORTED_CHAINS,
  SUPPORTED_TOKENS: IS_TESTNET ? TESTNET_TOKENS : SUPPORTED_TOKENS,
  EXPLORER_URLS: IS_TESTNET ? TESTNET_EXPLORER_URLS : EXPLORER_URLS,
  BOT_CONFIG,
  IS_TESTNET,
};