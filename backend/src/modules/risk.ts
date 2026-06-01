import { config } from '../config';
import { logger } from '../utils/logger';
import type { RiskParameters, PositionSizing, CatalystScore } from '../types';

/**
 * Risk Management Engine
 *
 * Enforces:
 *  - Max 1.5% portfolio risk per trade (dollar-stop method)
 *  - Dynamic position sizing scaled by catalyst score and active risk multiplier
 *  - Hard stop-loss price and multi-tiered take-profit targets
 *  - Daily loss circuit-breaker (shuts off new entries when daily loss > MAX_DAILY_LOSS_PCT)
 */
export class RiskEngine {
  private params: RiskParameters;
  private dailyRealizedPnl = 0;
  private startOfDayLiquidity = 0;
  private circuitBreakerTripped = false;

  constructor(accountLiquidity: number) {
    this.startOfDayLiquidity = accountLiquidity;
    this.params = {
      accountLiquidity,
      maxRiskPerTradePct: config.MAX_RISK_PER_TRADE_PCT,
      stopLossPct: config.STOP_LOSS_PCT,
      takeProfitTiers: [0.05, 0.10, 0.20],  // scale out at +5%, +10%, +20%
      maxOpenPositions: config.MAX_OPEN_POSITIONS,
      maxDailyLossPct: config.MAX_DAILY_LOSS_PCT,
    };
  }

  /** Called after each trade close to update P&L tracking. */
  recordPnl(pnl: number) {
    this.dailyRealizedPnl += pnl;
    const drawdownPct = Math.abs(Math.min(this.dailyRealizedPnl, 0)) / this.startOfDayLiquidity * 100;
    if (!this.circuitBreakerTripped && drawdownPct >= this.params.maxDailyLossPct) {
      this.circuitBreakerTripped = true;
      logger.error(
        'risk',
        `🔴 CIRCUIT BREAKER: Daily loss limit ${this.params.maxDailyLossPct}% reached. New entries BLOCKED.`,
        { drawdownPct, dailyPnl: this.dailyRealizedPnl }
      );
    }
  }

  /** Update live account liquidity (called after fills). */
  updateLiquidity(liquidity: number) {
    this.params.accountLiquidity = liquidity;
  }

  resetDailyStats(newLiquidity: number) {
    this.dailyRealizedPnl = 0;
    this.startOfDayLiquidity = newLiquidity;
    this.params.accountLiquidity = newLiquidity;
    this.circuitBreakerTripped = false;
    logger.info('risk', 'Daily stats reset for new session.');
  }

  /**
   * Returns null if the trade should be rejected.
   * Returns a PositionSizing object if approved, with exact share count and price levels.
   */
  size(
    symbol: string,
    entryPrice: number,
    catalyst: CatalystScore,
    openPositionCount: number
  ): PositionSizing | null {
    if (this.circuitBreakerTripped) {
      logger.warn('risk', `${symbol} rejected — circuit breaker is active.`);
      return null;
    }

    if (openPositionCount >= this.params.maxOpenPositions) {
      logger.warn('risk', `${symbol} rejected — max open positions (${this.params.maxOpenPositions}) reached.`);
      return null;
    }

    if (catalyst.score < 50) {
      logger.warn('risk', `${symbol} rejected — catalyst score ${catalyst.score}/100 below threshold.`);
      return null;
    }

    // Dynamic risk multiplier: scale position size by catalyst confidence
    const activeRiskMultiplier = Math.min(catalyst.confidence, 1.0);
    const effectiveRiskPct = this.params.maxRiskPerTradePct * activeRiskMultiplier;

    const dollarRisk = this.params.accountLiquidity * (effectiveRiskPct / 100);
    const stopLossPrice = entryPrice * (1 - this.params.stopLossPct / 100);
    const stopLossPerShare = entryPrice - stopLossPrice;

    const shares = Math.floor(dollarRisk / stopLossPerShare);

    if (shares < 1) {
      logger.warn('risk', `${symbol} rejected — computed shares < 1 (insufficient liquidity).`);
      return null;
    }

    const positionValue = shares * entryPrice;
    if (positionValue > this.params.accountLiquidity * 0.25) {
      // Hard cap: no single position > 25% of account
      const cappedShares = Math.floor((this.params.accountLiquidity * 0.25) / entryPrice);
      logger.warn('risk', `${symbol} position capped at 25% of account: ${cappedShares} shares.`);
      return this.buildSizing(symbol, cappedShares, entryPrice, stopLossPrice, dollarRisk);
    }

    logger.info(
      'risk',
      `${symbol} approved: ${shares} shares @ $${entryPrice.toFixed(2)} | Risk $${dollarRisk.toFixed(0)} | SL $${stopLossPrice.toFixed(2)}`,
      { effectiveRiskPct, activeRiskMultiplier }
    );

    return this.buildSizing(symbol, shares, entryPrice, stopLossPrice, dollarRisk);
  }

  private buildSizing(
    symbol: string,
    shares: number,
    entryPrice: number,
    stopLoss: number,
    dollarRisk: number
  ): PositionSizing {
    const takeProfits = this.params.takeProfitTiers.map((t) => entryPrice * (1 + t));
    return {
      symbol,
      shares,
      entryPrice,
      stopLoss,
      takeProfits,
      dollarRisk,
      positionValue: shares * entryPrice,
    };
  }

  get isCircuitBreakerActive() {
    return this.circuitBreakerTripped;
  }

  get activeRiskMultiplier() {
    return Math.max(0, 1 - Math.abs(Math.min(this.dailyRealizedPnl, 0)) / (this.startOfDayLiquidity * (this.params.maxDailyLossPct / 100)));
  }

  getParams(): RiskParameters {
    return { ...this.params };
  }
}
