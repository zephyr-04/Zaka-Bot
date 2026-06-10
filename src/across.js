require("dotenv").config();

const axios = require("axios");
const { ethers } = require("ethers");

const IS_TESTNET = process.env.TESTNET === "true";
const ACROSS_API = IS_TESTNET ? "https://testnet.across.to/api" : "https://app.across.to/api";

const http = axios.create({
  baseURL: ACROSS_API,
  timeout: 15_000,
  headers: {
    "User-Agent": "ZakaBot/1.0",
    "Accept": "application/json",
    ...(IS_TESTNET ? {} : { "Authorization": `Bearer ${process.env.ACROSS_API_KEY}` }),
  },
});

class AcrossService {

  async getQuote({ originChainId, destinationChainId, inputToken, outputToken, amount, decimals, recipient, depositor }) {
    const amountWei = ethers.parseUnits(amount.toString(), decimals).toString();
    const params = {
      tradeType: "exactInput",
      amount: amountWei,
      inputToken,
      outputToken,
      originChainId,
      destinationChainId,
      depositor: depositor || recipient,
      recipient,
      integratorId: process.env.ACROSS_INTEGRATOR_ID || "0x0000",
    };
    console.log("QUOTE PARAMS — depositor:", params.depositor, "recipient:", params.recipient);
    const { data } = await this._get("/swap/approval", params);
    return this._parseQuoteResponse(data, decimals, amount);
  }

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

  async getDepositStatus(originChainId, depositId) {
    const { data } = await this._get("/deposit/status", { originChainId, depositId });
    if (!data?.status) throw new Error("Unexpected status response from Across API.");
    return {
      status: data.status,
      fillTxHash: data.fillTxHash || null,
      destinationChainId: data.destinationChainId,
    };
  }

  async _get(path, params = {}) {
    let attempt = 0;
    const delays = [500, 1500, 3000];
    while (attempt < 3) {
      try {
        return await http.get(path, { params });
      } catch (err) {
        attempt++;
        const isRetryable = err.code === "ECONNABORTED" || (err.response?.status >= 500);
        if (!isRetryable || attempt >= 3) throw this._wrapError(err);
        await this._sleep(delays[attempt - 1]);
      }
    }
  }

  _parseQuoteResponse(data, decimals, inputAmount) {
    if (!data?.swapTx) {
      throw new Error(data?.message || "Invalid quote response from Across API.");
    }
    const bridge = data.steps?.bridge;
    const outputAmount = bridge?.outputAmount
      ? ethers.formatUnits(bridge.outputAmount.toString(), decimals)
      : "unknown";
    const fees = data.fees?.total;
    return {
      calldata: data.swapTx.data,
      toContract: data.swapTx.to,
      value: data.swapTx.value ? ethers.formatEther(data.swapTx.value.toString()) : "0",
      outputAmount: parseFloat(outputAmount).toFixed(6),
      estimatedFillTime: `~${data.expectedFillTime || 2} seconds`,
      approvalTxns: data.approvalTxns || [],
      fees: {
        lpFee: this._bpsToPercent(bridge?.fees?.details?.lp?.pct),
        relayerFee: this._bpsToPercent(bridge?.fees?.details?.relayerCapital?.pct),
        totalFee: fees?.pct ? this._bpsToPercent(fees.pct) : null,
        totalFeeAmount: fees?.amount
          ? ethers.formatUnits(fees.amount.toString(), decimals)
          : null,
      },
      isAmountTooLow: false,
    };
  }

  _bpsToPercent(bps) {
    if (!bps) return null;
    return (parseFloat(bps) / 1e16).toFixed(4) + "%";
  }

  _formatAmount(raw, decimals = 18) {
    if (!raw) return "N/A";
    try { return ethers.formatUnits(raw.toString(), decimals); }
    catch { return raw.toString(); }
  }

  _wrapError(err) {
    if (err.response?.data?.message) return new Error(`Across API: ${err.response.data.message}`);
    if (err.code === "ECONNABORTED") return new Error("Across API timed out. Please try again.");
    return new Error(`Across API error: ${err.message}`);
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

module.exports = { AcrossService };