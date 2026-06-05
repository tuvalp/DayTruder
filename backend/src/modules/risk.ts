import { logger } from '../utils/logger';
import { settingsStore } from './settings';
import type { PositionSizing, CatalystScore, ScannerAlert } from '../types';

export class RiskEngine {
  private accountLiquidity: number;
  private startOfDayLiquidity: number;
  private availableCash = 0;
  private dailyRealizedPnl = 0;
  private circuitBreakerTripped = false;

  constructor(accountLiquidity: number) {
    this.accountLiquidity = accountLiquidity;
    this.startOfDayLiquidity = accountLiquidity;
  }

  updateAvailableCash(cash: number) {
    this.availableCash = cash;
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

  /**
   * Quick pre-filter before calling Claude — checks if the trade math works out
   * after commissions. Returns rejection reason or null if trade is viable.
   */
  checkProfitMargin(alert: ScannerAlert): string | null {
    const s = settingsStore.get();
    const entryPrice = alert.suggestedEntry ?? alert.price;
    const totalCommission = s.commissionPerSide * 2;  // buy + sell

    // Minimum shares needed so commission isn't a dominant cost (< 20% of profit)
    // grossProfit = shares × entryPrice × (minTakeProfitPct/100)
    // netProfit = grossProfit - totalCommission ≥ minNetProfitDollar
    // → shares ≥ (minNetProfitDollar + totalCommission) / (entryPrice × takeProfitPct/100)
    const minSharesForMargin = Math.ceil(
      (s.minNetProfitDollar + totalCommission) / (entryPrice * (s.minTakeProfitPct / 100))
    );

    // How many shares will actually be bought (portfolio-pct sizing)
    const maxShares = Math.floor((this.accountLiquidity * (s.maxPositionSizePct / 100)) / entryPrice);

    if (maxShares < minSharesForMargin) {
      const grossAtMax = maxShares * entryPrice * (s.minTakeProfitPct / 100);
      const netAtMax = grossAtMax - totalCommission;
      return `Profit margin too thin: max ${maxShares} shares yields $${netAtMax.toFixed(0)} net at ${s.minTakeProfitPct}% TP (need $${s.minNetProfitDollar}+)`;
    }

    return null;  // trade passes margin check
  }

  size(
    symbol: string,
    entryPrice: number,
    catalyst: CatalystScore,
    openPositionCount: number,
    alert?: ScannerAlert,
    adaptivePositionSizePct?: number  // override from agent adaptive strategy
  ): PositionSizing | null {
    const s = settingsStore.get();

    if (this.circuitBreakerTripped) {
      logger.warn('risk', `${symbol} rejected — circuit breaker is active.`);
      return null;
    }

    // Use suggested entry from scanner if available (support/consolidation level)
    const actualEntry = alert?.suggestedEntry ?? entryPrice;
    const totalCommission = s.commissionPerSide * 2;

    const stopLossPrice = actualEntry * (1 - s.stopLossPct / 100);

    // ── Position sizing: deploy positionSizePct of portfolio ─────────────────
    // Adaptive override takes priority over settings value
    const targetSizePct = adaptivePositionSizePct ?? s.maxPositionSizePct;
    // Scale down on low-confidence setups (floor 70% of target)
    const confidenceScale = Math.max(0.7, Math.min(catalyst.confidence, 1.0));
    const deployPct = targetSizePct * confidenceScale;
    let positionValue = this.accountLiquidity * (deployPct / 100);

    // Cap to available cash — never deploy money we don't have
    if (this.availableCash > 0 && positionValue > this.availableCash) {
      logger.info('risk', `${symbol} position capped to available cash $${this.availableCash.toLocaleString()} (wanted $${positionValue.toFixed(0)})`);
      positionValue = this.availableCash * 0.99; // leave 1% buffer for fees
    }

    let shares = Math.floor(positionValue / actualEntry);

    if (shares < 1) {
      logger.warn('risk', `${symbol} rejected — computed shares < 1.`);
      return null;
    }

    const dollarRisk = shares * (actualEntry - stopLossPrice);

    // Ensure position is large enough to profit after commissions
    const minSharesForMargin = Math.ceil(
      (s.minNetProfitDollar + totalCommission) / (actualEntry * (s.minTakeProfitPct / 100))
    );
    if (shares < minSharesForMargin) {
      logger.warn('risk', `${symbol} rejected — ${shares} shares not enough to cover $${totalCommission} commission + $${s.minNetProfitDollar} profit target at ${s.minTakeProfitPct}% TP.`);
      return null;
    }

    // Take-profits: use minTakeProfitPct as TP1, scale up to max 50%
    // TP1 = minTakeProfitPct, TP2 = midpoint, TP3 = 50% (penny stock run target)
    const tp1Pct = s.minTakeProfitPct / 100;
    const tp2Pct = Math.min((s.minTakeProfitPct * 1.5) / 100, 0.40);
    const tp3Pct = 0.50;
    const takeProfits = [tp1Pct, tp2Pct, tp3Pct].map((t) =>
      parseFloat((actualEntry * (1 + t)).toFixed(2))
    );

    const grossProfitAtTP1 = shares * actualEntry * tp1Pct;
    const netProfitAtTP1   = grossProfitAtTP1 - totalCommission;

    logger.info(
      'risk',
      `${symbol} approved: ${shares} sh @ $${actualEntry.toFixed(2)} | SL $${stopLossPrice.toFixed(2)} (-${s.stopLossPct}%) | TP1 $${takeProfits[0]} (+${s.minTakeProfitPct}%) = net ~$${netProfitAtTP1.toFixed(0)} after $${totalCommission} commission`
    );

    return {
      symbol, shares, entryPrice: actualEntry,
      stopLoss: parseFloat(stopLossPrice.toFixed(2)),
      takeProfits, dollarRisk,
      positionValue: shares * actualEntry,
    };
  }

  get isCircuitBreakerActive() { return this.circuitBreakerTripped; }

  get activeRiskMultiplier() {
    const s = settingsStore.get();
    return Math.max(0, 1 - Math.abs(Math.min(this.dailyRealizedPnl, 0)) / (this.startOfDayLiquidity * (s.maxDailyLossPct / 100)));
  }
}
