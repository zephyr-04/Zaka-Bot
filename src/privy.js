require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");

const PRIVY_AUTH_API = "https://auth.privy.io/api/v1";
const PRIVY_API = "https://api.privy.io/v1";

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    "privy-app-id": process.env.PRIVY_APP_ID,
    "Authorization": `Basic ${Buffer.from(
      `${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`
    ).toString("base64")}`,
  };
}

function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

class PrivyService {

  // ─── EMAIL OTP ─────────────────────────────────────────────────────────────

  async sendEmailOTP(email) {
    try {
      await axios.post(
        `${PRIVY_AUTH_API}/passwordless/init`,
        { email, mode: "login-or-sign-up" },
        { headers: { "Content-Type": "application/json", "privy-app-id": process.env.PRIVY_APP_ID } }
      );
      console.log("OTP SEND: 200");
    } catch (err) {
      console.error("OTP SEND ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Failed to send verification code. Please try again.");
    }
  }

  async verifyEmailOTP(email, code) {
    try {
      const authResponse = await axios.post(
        `${PRIVY_AUTH_API}/passwordless/authenticate`,
        { email, code, mode: "login-or-sign-up" },
        { headers: { "Content-Type": "application/json", "privy-app-id": process.env.PRIVY_APP_ID } }
      );

      console.log("AUTH SUCCESS:", authResponse.data.user?.id);
      const { user } = authResponse.data;

      let walletAddress = null;
      let walletId = null;

      try {
        const wallet = await this._getOrCreateWallet(user.id);
        walletAddress = wallet.address;
        walletId = wallet.walletId;
      } catch (walletErr) {
        console.error("WALLET CREATION FAILED:", walletErr.message);
        // Auth succeeded — wallet can be created later
      }

      return { privyUserId: user.id, walletAddress, walletId };
    } catch (err) {
      console.error("VERIFY OTP ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Invalid or expired code. Please try again.");
    }
  }

  // ─── PRIVATE KEY IMPORT ────────────────────────────────────────────────────

  async importEVMWallet(privateKey, privyUserId) {
    let key = privateKey;
    try {
      const normalizedKey = key.startsWith("0x") ? key : "0x" + key;
      const response = await axios.post(
        `${PRIVY_API}/wallets/import`,
        {
          chain_type: "ethereum",
          private_key: normalizedKey,
          owner: { user_id: privyUserId },
        },
        { headers: adminHeaders() }
      );
      const { id: walletId, address } = response.data;
      console.log("EVM WALLET IMPORTED:", address);
      return { walletId, walletAddress: address };
    } catch (err) {
      console.error("EVM IMPORT ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Failed to import wallet. Please check your private key and try again.");
    } finally {
      key = null;
    }
  }

  async importSolanaWallet(privateKey, privyUserId) {
    let key = privateKey;
    try {
      const response = await axios.post(
        `${PRIVY_API}/wallets/import`,
        {
          chain_type: "solana",
          private_key: key,
          owner: { user_id: privyUserId },
        },
        { headers: adminHeaders() }
      );
      const { id: walletId, address } = response.data;
      console.log("SOLANA WALLET IMPORTED:", address);
      return { walletId, walletAddress: address };
    } catch (err) {
      console.error("SOLANA IMPORT ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Failed to import Solana wallet. Please check your private key and try again.");
    } finally {
      key = null;
    }
  }

  // ─── WALLET EXPORT ─────────────────────────────────────────────────────────

  async exportWallet(walletId) {
    try {
      const url = `${PRIVY_API}/wallets/${walletId}/export`;
      const body = {};
      const authSig = this._signRequest("POST", url, body);
      const response = await axios.post(url, body, {
        headers: { ...adminHeaders(), "privy-authorization-signature": authSig },
      });
      return response.data?.private_key || null;
    } catch (err) {
      console.error("EXPORT ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Could not export wallet. Please try again.");
    }
  }

  // ─── USER MANAGEMENT ───────────────────────────────────────────────────────

  async getUserOrCreate(telegramUserId) {
    // For imported wallets — create a bare Privy user linked to Telegram ID
    try {
      const response = await axios.post(
        `${PRIVY_AUTH_API}/users`,
        {},
        { headers: adminHeaders() }
      );
      console.log("PRIVY USER CREATED:", response.data?.id);
      return response.data?.id;
    } catch (err) {
      console.error("CREATE USER ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Could not create user account.");
    }
  }

  // ─── BALANCE FETCHING ──────────────────────────────────────────────────────

  async getEVMBalances(walletAddress) {
    const { ethers } = require("ethers");
    const { SUPPORTED_CHAINS, SUPPORTED_TOKENS } = require("../config/constants");

    // Public RPCs — no API key required
    const RPC_URLS = {
      1:     "https://eth.llamarpc.com",
      10:    "https://mainnet.optimism.io",
      137:   "https://polygon-rpc.com",
      8453:  "https://mainnet.base.org",
      42161: "https://arb1.arbitrum.io/rpc",
      59144: "https://rpc.linea.build",
    };

    const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
    const balances = [];

    await Promise.allSettled(
      SUPPORTED_CHAINS.map(async (chain) => {
        const rpcUrl = RPC_URLS[chain.id];
        if (!rpcUrl) return;

        try {
          const provider = new ethers.JsonRpcProvider(rpcUrl);

          // Native ETH balance
          const ethRaw = await provider.getBalance(walletAddress);
          const ethFormatted = parseFloat(ethers.formatEther(ethRaw));
          if (ethFormatted > 0.000001) {
            balances.push({ chain: chain.name, symbol: "ETH", balance: ethFormatted.toFixed(6) });
          }

          // ERC-20 balances
          await Promise.allSettled(
            SUPPORTED_TOKENS
              .filter(t => t.symbol !== "ETH" && t.addresses[chain.id])
              .map(async (token) => {
                try {
                  const contract = new ethers.Contract(token.addresses[chain.id], ERC20_ABI, provider);
                  const raw = await contract.balanceOf(walletAddress);
                  const formatted = parseFloat(ethers.formatUnits(raw, token.decimals));
                  if (formatted > 0.001) {
                    balances.push({
                      chain: chain.name,
                      symbol: token.symbol,
                      balance: formatted.toFixed(token.decimals === 6 ? 2 : 6),
                    });
                  }
                } catch { /* token not on this chain */ }
              })
          );
        } catch { /* RPC error */ }
      })
    );

    return balances;
  }

  // ─── TRANSACTIONS ──────────────────────────────────────────────────────────

  async sendTransaction(walletId, { to, data, value = "0", chainId }) {
    try {
      const gasLimit = this._estimateGas(chainId);
      const valueHex = value && value !== "0"
        ? `0x${BigInt(Math.round(parseFloat(value) * 1e18)).toString(16)}`
        : "0x0";

      const url = `${PRIVY_API}/wallets/${walletId}/rpc`;
      const body = {
        method: "eth_sendTransaction",
        caip2: `eip155:${chainId}`,
        params: {
          transaction: {
            to,
            data: data || "0x",
            value: valueHex,
            gas_limit: gasLimit,
          },
        },
      };

      const authSig = this._signRequest("POST", url, body);
      console.log("SENDING TX to wallet:", walletId, "on chain:", chainId);

      const response = await axios.post(url, body, {
        headers: { ...adminHeaders(), "privy-authorization-signature": authSig },
      });

      console.log("TX RESPONSE:", JSON.stringify(response.data, null, 2));
      return response.data?.data?.hash || response.data?.hash || null;
    } catch (err) {
      console.error("TX ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error(err.response?.data?.error || "Transaction failed. Please try again.");
    }
  }

  // ─── PRIVATE ───────────────────────────────────────────────────────────────

  async _getOrCreateWallet(privyUserId) {
    try {
      const userResponse = await axios.get(
        `${PRIVY_AUTH_API}/users/${privyUserId}`,
        { headers: adminHeaders() }
      );

      const linked = userResponse.data?.linked_accounts || [];
      const existingWallet = linked.find(
        (a) => a.type === "wallet" && a.wallet_client_type === "privy"
      );

      if (existingWallet?.address) {
        const walletId = await this._getWalletIdByAddress(existingWallet.address);
        console.log("EXISTING WALLET:", existingWallet.address, walletId);
        return { address: existingWallet.address, walletId };
      }

      // Create wallet owned by key quorum
      const walletResponse = await axios.post(
        `${PRIVY_API}/wallets`,
        { chain_type: "ethereum", owner_id: process.env.PRIVY_SIGNER_ID },
        { headers: adminHeaders() }
      );

      const { id: walletId, address } = walletResponse.data;
      console.log("WALLET CREATED:", address, walletId);
      return { address, walletId };
    } catch (err) {
      console.error("WALLET ERROR:", err.response?.status, err.response?.data?.error);
      throw new Error("Could not create wallet. Please try again.");
    }
  }

  async _getWalletIdByAddress(address) {
    try {
      const response = await axios.get(
        `${PRIVY_API}/wallets?owner_id=${process.env.PRIVY_SIGNER_ID}`,
        { headers: adminHeaders() }
      );
      const wallets = response.data?.data || [];
      const match = wallets.find(w => w.address?.toLowerCase() === address.toLowerCase());
      return match?.id || null;
    } catch {
      return null;
    }
  }

  _signRequest(method, url, body) {
    try {
      const privateKey = process.env.PRIVY_AUTH_PRIVATE_KEY;
      const fullKey = privateKey.includes("BEGIN")
        ? privateKey.replace(/\\n/g, "\n")
        : `-----BEGIN EC PRIVATE KEY-----\n${privateKey}\n-----END EC PRIVATE KEY-----`;

      const payload = {
        version: 1,
        method: method.toUpperCase(),
        url,
        body,
        headers: { "privy-app-id": process.env.PRIVY_APP_ID },
      };

      const canonical = canonicalize(payload);
      const sign = crypto.createSign("SHA256");
      sign.update(Buffer.from(canonical));
      const signature = sign.sign({ key: fullKey, format: "pem" }, "base64");
      console.log("SIGNATURE:", signature.substring(0, 20) + "...");
      return signature;
    } catch (err) {
      console.error("SIGN ERROR:", err.message);
      return "";
    }
  }

  _estimateGas(chainId) {
    const defaults = {
      1: 200000, 10: 500000, 137: 500000,
      8453: 500000, 42161: 1000000, 324: 1000000, 59144: 500000,
    };
    return defaults[chainId] || 300000;
  }
}

module.exports = { PrivyService };