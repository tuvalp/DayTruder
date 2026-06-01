import { logger } from '../utils/logger';
import { settingsStore } from './settings';
import type { PositionSizing, CatalystScore } from '../types';

export class RiskEngine {
  private accountLiquidity: number;
  private startOfDayLiquidity: number;
  private dailyRealizedPnl = 0;
  private circuitBreakerTripped = false;

  constructor(accountLiquidity: number) {
    this.accountLiquidity = accountLiquidity;
    this.startOfDayLiquidity = accountLiquidity;
  }

  recordPnl(pnl: number) {
    this.dailyRealizedPnl += pnl;
    const s = settingsStore.get();
    const drawdownPct = Math.abs(Math.min(this.dailyRealizedPnl, 0)) / this.startOfDayLiquidity * 100;
    if (!this.circuitBreakerTripped && drawdownPct >= s.maxDailyLossPct) {
      this.circuitBreakerTripped = true;
      logger.error('risk', `🔴 CIRCUIT BREAKER: Daily loss limit ${s.maxDailyLossPct}% reached. New entries BLOCKED.`);
    }
  }

  updateLiquidity(liquidity: number) {
    this.accountLiquidity = liquidity;
  }

  resetDailyStats(newLiquidity: number) {
    this.dailyRealizedPnl = 0;
    this.startOfDayLiquidity = newLiquidity;
    this.accountLiquidity = newLiquidity;
    this.circuitBreakerTripped = false;
    logger.info('risk', 'Daily stats reset for new session.');
  }

  size(
    symbol: string,
    entryPrice: number,
    catalyst: CatalystScore,
    openPositionCount: number
  ): PositionSizing | null {
    const s = settingsStore.get();   // always read live settings

    if (this.circuitBreakerTripped) {
      logger.warn('risk', `${symbol} rejected — circuit breaker is active.`);
      return null;
    }
    if (openPositionCount >= s.maxOpenPositions) {
      logger.warn('risk', `${symbol} rejected — max open positions (${s.maxOpenPositions}) reached.`);
      return null;
    }
    if (catalyst.score < 50) {
      logger.warn('risk', `${symbol} rejected — catalyst score ${catalyst.score}/100 below threshold.`);
      return null;
    }

    const activeRiskMultiplier = Math.min(catalyst.confidence, 1.0);
    const effectiveRiskPct = s.maxRiskPerTradePct * activeRiskMultiplier;
    const dollarRisk = this.accountLiquidity * (effectiveRiskPct / 100);
    const stopLossPrice = entryPrice * (1 - s.stopLossPct / 100);
    const stopLossPerShare = entryPrice - stopLossPrice;
    let shares = Math.floor(dollarRisk / stopLossPerShare);

    if (shares < 1) {
      logger.warn('risk', `${symbol} rejected — computed shares < 1.`);
      return null;
    }

    const maxShares = Math.floor((this.accountLiquidity * 0.25) / entryPrice);
    if (shares > maxShares) {
      logger.warn('risk', `${symbol} capped at 25% of account: ${maxShares} shares.`);
      shares = maxShares;
    }

    logger.info('risk', `${symbol} approved: ${shares} sh @ $${entryPrice.toFixed(2)} | Risk $${dollarRisk.toFixed(0)} | SL $${stopLossPrice.toFixed(2)}`);

    const takeProfits = [0.05, 0.10, 0.20].map((t) => entryPrice * (1 + t));
    return { symbol, shares, entryPrice, stopLoss: stopLossPrice, takeProfits, dollarRisk, positionValue: shares * entryPrice };
  }

  get isCircuitBreakerActive() { return this.circuitBreakerTripped; }

  get activeRiskMultiplier() {
    const s = settingsStore.get();
    return Math.max(0, 1 - Math.abs(Math.min(this.dailyRealizedPnl, 0)) / (this.startOfDayLiquidity * (s.maxDailyLossPct / 100)));
  }
}
