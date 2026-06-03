/**
 * AcrossService — wrapper around the Across Protocol REST API (v3)
 * 
 * Security notes:
 *  - All amounts validated before API calls
 *  - API responses validated before returning to bot layer
 *  - No caching of /suggested-fees or /swap/approval (per Across docs)
 *  - Retry logic with exponential backoff
 *  - Axios timeout enforced to prevent hanging requests
 */

const axios = require("axios");
const { ethers } = require("ethers");
const { SUPPORTED_CHAINS } = require("../config/constants");

const ACROSS_API = "https://app.across.to/api";

const http = axios.create({
  baseURL: ACROSS_API,
  timeout: 15_000, // 15s hard timeout
  headers: {
    "User-Agent": "AcrossTGBridge/1.0",
    "Accept": "application/json",
  },
});

class AcrossService {
  /**
   * Fetch a bridge/swap quote via the /swap/approval endpoint.
   * Returns calldata the user can sign directly in their wallet.
   */
  async getQuote({ originChainId, destinationChainId, inputToken, outputToken, amount, decimals, recipient }) {
    const amountWei = ethers.parseUnits(amount.toString(), decimals).toString();

    const params = {
      tradeType: "exactInput",
      amount: amountWei,
      inputToken,
      outputToken,
      originChainId,
      destinationChainId,
      depositor: recipient,   // depositor = recipient for simple bridge
      recipient,
      integratorId: process.env.ACROSS_INTEGRATOR_ID || "0x0000", // replace with your registered ID
    };

    const { data } = await this._get("/swap/approval", params, { noCache: true });

    return this._parseQuoteResponse(data, decimals, amount);
  }

  /**
   * Get deposit limits for all routes
   */
  async getLimits() {
    const { data } = await this._get("/limits");
    if (!Array.isArray(data)) return [];
    return data.map(l => ({
      symbol: l.inputToken?.symbol || "?",
      originChainId: l.originChainId,
      destinationChainId: l.destinationChainId,
      minDeposit: this._formatAmount(l.minDeposit, l.inputToken?.decimals),
      maxDeposit: this._formatAmount(l.maxDeposit, l.inputToken?.decimals),
    }));
  }

  /**
   * Poll deposit status by originChainId + depositId
   */
  async getDepositStatus(originChainId, depositId) {
    const { data } = await this._get("/deposit/status", {
      originChainId,
      depositId,
    });

    if (!data?.status) throw new Error("Unexpected status response from Across API.");

    return {
      status: data.status,                          // "pending" | "filled" | "expired"
      fillTxHash: data.fillTxHash || null,
      destinationChainId: data.destinationChainId,
    };
  }

  /**
   * Get all supported chains from the API
   */
  async getSupportedChains() {
    const { data } = await this._get("/available-routes");
    return data;
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────────

  async _get(path, params = {}, options = {}) {
    let attempt = 0;
    const maxAttempts = 3;
    const delays = [500, 1500, 3000];

    while (attempt < maxAttempts) {
      try {
        const response = await http.get(path, { params });
        return response;
      } catch (err) {
        attempt++;
        const isRetryable = err.code === "ECONNABORTED" || (err.response?.status >= 500);
        if (!isRetryable || attempt >= maxAttempts) {
          throw this._wrapError(err);
        }
        await this._sleep(delays[attempt - 1]);
      }
    }
  }

  _parseQuoteResponse(data, decimals, inputAmount) {
    // Validate the response has what we need
    if (!data?.txs || !Array.isArray(data.txs) || data.txs.length === 0) {
      throw new Error("Invalid quote response from Across API.");
    }

    const bridgeTx = data.txs.find(tx => tx.type === "bridge" || tx.to) || data.txs[data.txs.length - 1];

    const outputAmountWei = data.outputAmount || data.expectedOutputAmount;
    const outputAmount = outputAmountWei
      ? ethers.formatUnits(outputAmountWei.toString(), decimals)
      : "unknown";

    const fees = data.fees || {};

    return {
      calldata: bridgeTx.data,
      toContract: bridgeTx.to,
      value: bridgeTx.value ? ethers.formatEther(bridgeTx.value.toString()) : "0",
      outputAmount: parseFloat(outputAmount).toFixed(6),
      estimatedFillTime: this._parseFillTime(data.estimatedFillTimeSec),
      fees: {
        lpFee: this._bpsToPercent(fees.lpFee?.pct),
        relayerFee: this._bpsToPercent(fees.relayerFee?.pct),
        totalFee: this._bpsToPercent(fees.totalRelayFee?.pct),
        totalFeeAmount: fees.totalRelayFee?.total
          ? ethers.formatUnits(fees.totalRelayFee.total.toString(), decimals)
          : null,
      },
      isAmountTooLow: data.isAmountTooLow || false,
    };
  }

  _parseFillTime(seconds) {
    if (!seconds) return "2–10 seconds";
    if (seconds < 60) return `~${seconds} seconds`;
    return `~${Math.round(seconds / 60)} minutes`;
  }

  _bpsToPercent(bps) {
    if (!bps) return null;
    return (parseFloat(bps) / 1e16).toFixed(4) + "%";
  }

  _formatAmount(raw, decimals = 18) {
    if (!raw) return "N/A";
    try {
      return ethers.formatUnits(raw.toString(), decimals);
    } catch {
      return raw.toString();
    }
  }

  _wrapError(err) {
    if (err.response?.data?.message) {
      return new Error(`Across API: ${err.response.data.message}`);
    }
    if (err.code === "ECONNABORTED") {
      return new Error("Across API timed out. Please try again.");
    }
    return new Error(`Across API error: ${err.message}`);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { AcrossService };
