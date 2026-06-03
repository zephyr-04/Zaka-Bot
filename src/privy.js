require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");

const PRIVY_AUTH_API = "https://auth.privy.io/api/v1";
const PRIVY_API = "https://api.privy.io/v1";

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    "privy-app-id": process.env.PRIVY_APP_ID,
    "Authorization": `Basic ${Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString("base64")}`,
  };
}

// Manual canonicalization — sorts keys recursively for deterministic JSON
function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

class PrivyService {

  async sendEmailOTP(email) {
    try {
      const response = await axios.post(
        `${PRIVY_AUTH_API}/passwordless/init`,
        { email, mode: "login-or-sign-up" },
        { headers: { "Content-Type": "application/json", "privy-app-id": process.env.PRIVY_APP_ID } }
      );
      console.log("OTP SEND:", response.status);
    } catch (err) {
      console.log("OTP SEND ERROR:", err.response?.status, JSON.stringify(err.response?.data));
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

    // Wallet creation is separate — auth already succeeded at this point
    let walletAddress = null;
    let walletId = null;

    try {
      const wallet = await this._getOrCreateWallet(user.id);
      walletAddress = wallet.address;
      walletId = wallet.walletId;
    } catch (walletErr) {
      console.log("WALLET CREATION FAILED:", walletErr.message);
      // Don't fail the whole flow — user is authenticated, wallet can be created later
    }

    return { privyUserId: user.id, walletAddress, walletId };

  } catch (err) {
    console.log("VERIFY OTP ERROR:", err.response?.status, JSON.stringify(err.response?.data));
    throw new Error("Invalid or expired code. Please try again.");
  }
}
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
        headers: {
          ...adminHeaders(),
          "privy-authorization-signature": authSig,
        },
      });

      console.log("TX RESPONSE:", JSON.stringify(response.data, null, 2));
      return response.data?.data?.hash || response.data?.hash || null;

    } catch (err) {
      console.log("TX ERROR:", err.response?.status, JSON.stringify(err.response?.data, null, 2));
      throw new Error(err.response?.data?.error || err.message);
    }
  }

  async _getOrCreateWallet(privyUserId) {
    try {
      // Look up existing wallet via user's linked accounts
      const userResponse = await axios.get(
        `${PRIVY_AUTH_API}/users/${privyUserId}`,
        { headers: adminHeaders() }
      );

      const linked = userResponse.data?.linked_accounts || [];
      const existingWallet = linked.find(
        (a) => a.type === "wallet" && a.wallet_client_type === "privy"
      );

      if (existingWallet?.address) {
        // Get wallet ID from wallets API
        const walletId = await this._getWalletIdByAddress(existingWallet.address);
        console.log("EXISTING WALLET:", existingWallet.address, walletId);
        return { address: existingWallet.address, walletId };
      }

      // Create new wallet — owner_id is the key quorum ID
      const walletResponse = await axios.post(
        `${PRIVY_API}/wallets`,
        {
          chain_type: "ethereum",
          owner_id: process.env.PRIVY_SIGNER_ID,
        },
        { headers: adminHeaders() }
      );

      const { id: walletId, address } = walletResponse.data;
      console.log("WALLET CREATED:", address, walletId);
      return { address, walletId };

    } catch (err) {
      console.log("WALLET ERROR:", err.response?.status, JSON.stringify(err.response?.data));
      throw new Error("Could not create wallet. Please try again.");
    }
  }

  async _getWalletIdByAddress(address) {
    try {
      // List all wallets owned by our key quorum and find by address
      const response = await axios.get(
        `${PRIVY_API}/wallets?owner_id=${process.env.PRIVY_SIGNER_ID}`,
        { headers: adminHeaders() }
      );
      const wallets = response.data?.data || [];
      const match = wallets.find(w => w.address?.toLowerCase() === address.toLowerCase());
      return match?.id || null;
    } catch (err) {
      console.log("GET WALLET ID ERROR:", err.response?.status, JSON.stringify(err.response?.data));
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

      // Use recursive canonicalization for deterministic JSON
      const canonical = canonicalize(payload);
      const serializedBuffer = Buffer.from(canonical);

      const sign = crypto.createSign("SHA256");
      sign.update(serializedBuffer);
      const signature = sign.sign({ key: fullKey, format: "pem" }, "base64");
      console.log("SIGNATURE:", signature.substring(0, 20) + "...");
      return signature;

    } catch (err) {
      console.log("SIGN ERROR:", err.message);
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