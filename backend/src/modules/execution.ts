import {
  IBApi,
  EventName,
  Contract,
  Order as IBOrder,
  OrderAction,
  OrderType as IBOrderType,
  SecType,
  Currency,
  TimeInForce,
} from '@stoqey/ib';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { Order, Position, PositionSizing, CatalystScore, OrderStatus } from '../types';

/**
 * Order Execution Module — IBKR
 *
 * Connects to TWS / IB Gateway via the shared IBApi instance.
 * Submits bracket orders:
 *   - Parent: Limit BUY
 *   - Child 1: Stop SELL (hard stop-loss)
 *   - Child 2: Limit SELL (first take-profit)
 *
 * IBKR bracket orders use transmit=false on the parent and first child,
 * transmit=true on the last child to send all three atomically.
 */
export class ExecutionModule {
  private ib: IBApi;
  private positions = new Map<string, Position>();
  private orderIdBase: number | null = null;
  private nextOrderIdOffset = 0;
  private account: string = config.IBKR_ACCOUNT ?? '';

  constructor(ib: IBApi) {
    this.ib = ib;
    this.ib.on(EventName.nextValidId, (orderId: number) => {
      this.orderIdBase = orderId;
      logger.info('execution', `IBKR next valid order ID: ${orderId}`);
    });
    this.ib.on(EventName.orderStatus, this.onOrderStatus.bind(this));
  }

  async submitBracketOrder(
    sizing: PositionSizing,
    catalyst: CatalystScore
  ): Promise<Position | null> {
    const { symbol, shares, entryPrice, stopLoss, takeProfits } = sizing;

    if (this.orderIdBase === null) {
      logger.error('execution', 'No valid order ID from TWS yet — cannot submit order.');
      return null;
    }

    const parentId = this.orderIdBase + this.nextOrderIdOffset++;
    const slId     = this.orderIdBase + this.nextOrderIdOffset++;
    const tpId     = this.orderIdBase + this.nextOrderIdOffset++;

    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      currency: Currency.USD,
      exchange: 'SMART',
    };

    const limitPrice = parseFloat((entryPrice * 1.005).toFixed(2));  // 0.5% slippage buffer

    // ── Parent: Limit BUY ────────────────────────────────────────────────────
    const parentOrder: IBOrder = {
      orderId: parentId,
      action: OrderAction.BUY,
      orderType: IBOrderType.LMT,
      totalQuantity: shares,
      lmtPrice: limitPrice,
      tif: TimeInForce.DAY,
      transmit: false,          // hold — send atomically with children
      account: this.account,
    };

    // ── Child 1: Stop SELL (stop-loss) ───────────────────────────────────────
    const slOrder: IBOrder = {
      orderId: slId,
      action: OrderAction.SELL,
      orderType: IBOrderType.STP,
      totalQuantity: shares,
      auxPrice: parseFloat(stopLoss.toFixed(2)),
      tif: TimeInForce.GTC,
      parentId,
      transmit: false,
      account: this.account,
    };

    // ── Child 2: Limit SELL (first take-profit) ──────────────────────────────
    const tpOrder: IBOrder = {
      orderId: tpId,
      action: OrderAction.SELL,
      orderType: IBOrderType.LMT,
      totalQuantity: shares,
      lmtPrice: parseFloat(takeProfits[0].toFixed(2)),
      tif: TimeInForce.GTC,
      parentId,
      transmit: true,           // transmit=true sends the whole bracket
      account: this.account,
    };

    logger.trade(
      'execution',
      `Submitting IBKR bracket: BUY ${shares} ${symbol} @ $${limitPrice} | SL $${stopLoss.toFixed(2)} | TP $${takeProfits[0].toFixed(2)}`
    );

    try {
      this.ib.placeOrder(parentId, contract, parentOrder);
      this.ib.placeOrder(slId,     contract, slOrder);
      this.ib.placeOrder(tpId,     contract, tpOrder);
    } catch (err) {
      logger.error('execution', `placeOrder error: ${String(err)}`);
      return null;
    }

    const entryOrder: Order = {
      id: uuidv4(),
      brokerOrderId: String(parentId),
      symbol,
      side: 'buy',
      type: 'limit',
      quantity: shares,
      limitPrice,
      status: 'pending',
      submittedAt: Date.now(),
    };

    const position: Position = {
      id: uuidv4(),
      symbol,
      shares,
      avgPrice: entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      stopLoss,
      takeProfits,
      status: 'open',
      openedAt: Date.now(),
      catalystScore: catalyst,
      orders: [entryOrder],
    };

    this.positions.set(symbol, position);
    logger.success('execution', `Position registered: ${symbol} — IBKR order IDs ${parentId}/${slId}/${tpId}`);
    return position;
  }

  async closePosition(symbol: string): Promise<boolean> {
    const position = this.positions.get(symbol);
    if (!position) {
      logger.warn('execution', `closePosition: no open position for ${symbol}`);
      return false;
    }

    if (this.orderIdBase === null) return false;
    const mktOrderId = this.orderIdBase + this.nextOrderIdOffset++;

    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      currency: Currency.USD,
      exchange: 'SMART',
    };

    const mktSell: IBOrder = {
      orderId: mktOrderId,
      action: OrderAction.SELL,
      orderType: IBOrderType.MKT,
      totalQuantity: position.shares,
      tif: TimeInForce.DAY,
      transmit: true,
      account: this.account,
    };

    try {
      this.ib.placeOrder(mktOrderId, contract, mktSell);
      position.status = 'closed';
      position.closedAt = Date.now();
      this.positions.delete(symbol);
      logger.trade('execution', `Market close submitted for ${symbol} (orderId ${mktOrderId})`);
      return true;
    } catch (err) {
      logger.error('execution', `Failed to close ${symbol}: ${String(err)}`);
      return false;
    }
  }

  /** Sync open position prices from IBKR portfolio events. */
  syncPositionPrice(symbol: string, currentPrice: number) {
    const pos = this.positions.get(symbol);
    if (!pos) return;
    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.avgPrice) * pos.shares;
    pos.unrealizedPnlPct = ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100;
  }

  async getAccountLiquidity(): Promise<number> {
    // Ensure we have the account number before requesting updates
    await this.ensureAccount();

    return new Promise((resolve, reject) => {
      const handler = (_account: string, key: string, value: string) => {
        if (key === 'NetLiquidation') {
          this.ib.off(EventName.updateAccountValue, handler);
          clearTimeout(timer);
          const liquidity = parseFloat(value);
          logger.success('execution', `Net liquidity: $${liquidity.toLocaleString()}`);
          resolve(liquidity);
        }
      };
      this.ib.on(EventName.updateAccountValue, handler);
      this.ib.reqAccountUpdates(true, this.account);

      const timer = setTimeout(() => {
        this.ib.off(EventName.updateAccountValue, handler);
        reject(new Error(`IBKR account update timed out for account ${this.account}`));
      }, 15_000);
    });
  }

  private ensureAccount(): Promise<void> {
    if (this.account) return Promise.resolve();
    return new Promise((resolve) => {
      const handler = (accountsList: string) => {
        this.account = accountsList.split(',')[0].trim();
        logger.success('execution', `Auto-detected IBKR account: ${this.account}`);
        resolve();
      };
      // May have already fired — request it explicitly
      this.ib.once(EventName.managedAccounts, handler);
      this.ib.reqManagedAccts();
      // If still not received in 5 s, proceed with empty string (TWS will respond with all accounts)
      setTimeout(() => {
        this.ib.off(EventName.managedAccounts, handler);
        resolve();
      }, 5_000);
    });
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'open');
  }

  private onOrderStatus(
    orderId: number,
    status: string,
    filled: number,
    _remaining: number,
    avgFillPrice: number
  ) {
    // Find the position that owns this order and update fill data
    for (const pos of this.positions.values()) {
      const order = pos.orders.find((o) => o.brokerOrderId === String(orderId));
      if (!order) continue;
      order.status = this.mapStatus(status);
      order.filledQty = filled;
      order.avgFillPrice = avgFillPrice;
      if (status === 'Filled') {
        order.filledAt = Date.now();
        pos.avgPrice = avgFillPrice || pos.avgPrice;
        logger.success('execution', `Order ${orderId} FILLED: ${filled} @ $${avgFillPrice}`);
      }
    }
  }

  private mapStatus(ibStatus: string): OrderStatus {
    const map: Record<string, OrderStatus> = {
      PreSubmitted: 'pending',
      Submitted:    'pending',
      Filled:       'filled',
      PartiallyFilled: 'partially_filled',
      Cancelled:    'cancelled',
      Inactive:     'cancelled',
    };
    return map[ibStatus] ?? 'pending';
  }
}
