import {
  IBApi,
  EventName,
  Contract,
  Order as IBOrder,
  OrderAction,
  OrderType as IBOrderType,
  SecType,
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
  // reqId range 5000–5999 reserved for position live-price subscriptions
  private posReqIdCounter = 5000;
  private posReqIdToSymbol = new Map<number, string>();
  private onPositionsChange?: () => void;

  constructor(ib: IBApi) {
    this.ib = ib;
    this.ib.on(EventName.nextValidId, (orderId: number) => {
      this.orderIdBase = orderId;
      logger.info('execution', `IBKR next valid order ID: ${orderId}`);
    });
    this.ib.on(EventName.orderStatus, this.onOrderStatus.bind(this));
  }

  /**
   * Subscribe live reqMktData + ongoing reqPositions for all open positions.
   * Calls onPositionsChange whenever a price or P&L value updates so the
   * caller (agent) can re-emit the portfolio snapshot immediately.
   */
  startLiveTracking(onPositionsChange: () => void) {
    this.onPositionsChange = onPositionsChange;

    // ── Live price ticks for position symbols ─────────────────────────────────
    const ib = this.ib as unknown as {
      on: (e: string, h: (...a: unknown[]) => void) => void;
      reqMktData: (...a: unknown[]) => void;
      cancelMktData: (id: number) => void;
      reqPositions: () => void;
      cancelPositions: () => void;
    };

    ib.on('tickPrice', (reqId: unknown, tickType: unknown, price: unknown) => {
      const symbol = this.posReqIdToSymbol.get(reqId as number);
      const tt = tickType as number;
      // 4 = real-time last, 68 = delayed last
      if (!symbol || (tt !== 4 && tt !== 68) || (price as number) <= 0) return;
      this.syncPositionPrice(symbol, price as number);
      this.onPositionsChange?.();
    });

    // ── Ongoing position updates from TWS (fires when shares/cost changes) ────
    ib.on('position', (_account: unknown, contract: unknown, pos: unknown, avgCost: unknown) => {
      const symbol = (contract as { symbol: string }).symbol;
      if (!symbol) return;
      const shares = Math.abs(pos as number);
      const existing = this.positions.get(symbol);
      if (existing && existing.status === 'open') {
        existing.shares   = shares;
        existing.avgPrice = avgCost as number;
        if (shares === 0) { existing.status = 'closed'; this.cancelPositionMktData(symbol); }
      } else if (shares > 0 && !existing) {
        // Position opened outside agent (manual TWS trade)
        this.positions.set(symbol, {
          id: uuidv4(), symbol, shares,
          avgPrice: avgCost as number, currentPrice: avgCost as number,
          unrealizedPnl: 0, unrealizedPnlPct: 0,
          stopLoss: (avgCost as number) * 0.93,
          takeProfits: [(avgCost as number) * 1.25, (avgCost as number) * 1.37, (avgCost as number) * 1.50],
          status: 'open', openedAt: Date.now(),
          catalystScore: { symbol, score: 0, sentiment: 'neutral', catalystType: 'Manual TWS', headline: 'Opened outside agent', reasoning: '', confidence: 0, analyzedAt: Date.now() },
          orders: [],
        });
        this.subscribePositionMktData(symbol);
      }
      this.onPositionsChange?.();
    });

    // Subscribe market data for any already-known positions (from sync)
    for (const pos of this.getOpenPositions()) {
      this.subscribePositionMktData(pos.symbol);
    }

    // Start streaming position updates from TWS
    ib.reqPositions();
    logger.info('execution', 'Live position tracking started (price ticks + position stream)');
  }

  private subscribePositionMktData(symbol: string) {
    if ([...this.posReqIdToSymbol.values()].includes(symbol)) return;
    const reqId = this.posReqIdCounter++;
    this.posReqIdToSymbol.set(reqId, symbol);
    const contract: Contract = { symbol, secType: SecType.STK, currency: 'USD', exchange: 'SMART' };
    (this.ib as unknown as { reqMktData: (...a: unknown[]) => void })
      .reqMktData(reqId, contract, '', false, false, []);
  }

  private cancelPositionMktData(symbol: string) {
    for (const [reqId, sym] of this.posReqIdToSymbol.entries()) {
      if (sym !== symbol) continue;
      try { this.ib.cancelMktData(reqId); } catch { /* ignore */ }
      this.posReqIdToSymbol.delete(reqId);
      break;
    }
  }

  getOpenOrders(): Order[] {
    const orders: Order[] = [];
    for (const pos of this.positions.values()) {
      orders.push(...pos.orders);
    }
    return orders;
  }

  /**
   * Pull all open positions from IBKR TWS and merge them into the local map.
   * Existing positions submitted this session keep their stop/TP data.
   * Positions found in IBKR but not in local map are imported (e.g. after restart).
   */
  syncPositionsFromIBKR(): Promise<void> {
    return new Promise((resolve) => {
      const seen = new Set<string>();

      const posHandler = (
        _account: string,
        _contract: Contract,
        pos: number,
        avgCost: number
      ) => {
        const symbol: string = (_contract as unknown as { symbol: string }).symbol;
        if (!symbol || pos === 0) return;
        seen.add(symbol);

        const existing = this.positions.get(symbol);
        if (existing) {
          // Update shares / avg cost in case they changed (partial fills, averaging)
          existing.shares   = Math.abs(pos);
          existing.avgPrice = avgCost;
        } else {
          // Import position that existed before this session started
          const ibPos: Position = {
            id: uuidv4(),
            symbol,
            shares: Math.abs(pos),
            avgPrice: avgCost,
            currentPrice: avgCost,
            unrealizedPnl: 0,
            unrealizedPnlPct: 0,
            stopLoss: avgCost * 0.96,      // default 4% SL until agent can set a real one
            takeProfits: [avgCost * 1.06, avgCost * 1.12, avgCost * 1.20],
            status: 'open',
            openedAt: Date.now(),
            catalystScore: {
              symbol,
              score: 0,
              sentiment: 'neutral',
              catalystType: 'Imported from IBKR',
              headline: 'Position existed before agent session',
              reasoning: 'Imported from TWS on agent startup',
              confidence: 0,
              analyzedAt: Date.now(),
            },
            orders: [],
          };
          this.positions.set(symbol, ibPos);
          logger.info('execution', `Imported IBKR position: ${symbol} × ${ibPos.shares} @ $${avgCost.toFixed(2)}`);
        }
      };

      const endHandler = () => {
        this.ib.off(EventName.position, posHandler);
        this.ib.off(EventName.positionEnd, endHandler);

        // Mark any local positions no longer in IBKR as closed
        for (const [sym, p] of this.positions.entries()) {
          if (p.status === 'open' && !seen.has(sym)) {
            p.status = 'closed';
            logger.info('execution', `Position ${sym} no longer held in IBKR — marked closed`);
          }
        }

        const open = this.getOpenPositions();
        logger.success('execution', `IBKR position sync complete — ${open.length} open position(s): ${open.map((p) => `${p.symbol} ×${p.shares}`).join(', ') || 'none'}`);
        resolve();
      };

      const ib = this.ib as unknown as { on: (e: string, h: unknown) => void; off: (e: string, h: unknown) => void; reqPositions: () => void };
      ib.on('position', posHandler);
      ib.on('positionEnd', endHandler);
      this.ib.reqPositions();

      // Safety timeout — resolve even if positionEnd never fires
      setTimeout(() => {
        ib.off('position', posHandler);
        ib.off('positionEnd', endHandler);
        resolve();
      }, 10_000);
    });
  }

  /**
   * Pull all open/pending orders from TWS and attach them to matching positions.
   * Uses reqOpenOrders() which returns only orders placed by this client ID.
   * Also captures stop-loss and take-profit prices so the dashboard can show them.
   */
  syncOpenOrdersFromIBKR(): Promise<void> {
    return new Promise((resolve) => {
      const orderHandler = (
        orderId: number,
        contract: Contract,
        order: IBOrder,
      ) => {
        const symbol: string = (contract as unknown as { symbol: string }).symbol;
        if (!symbol) return;

        const pos = this.positions.get(symbol);
        if (!pos) return;

        // Avoid duplicates
        if (pos.orders.some((o) => o.brokerOrderId === String(orderId))) return;

        const ibOrderType = order.orderType as string;
        const side = (order.action as string) === 'SELL' ? 'sell' : 'buy';

        const appOrder: Order = {
          id: uuidv4(),
          brokerOrderId: String(orderId),
          symbol,
          side,
          type: ibOrderType === 'STP' ? 'stop' : ibOrderType === 'LMT' ? 'limit' : 'market',
          quantity: Number(order.totalQuantity ?? 0),
          limitPrice: order.lmtPrice ?? undefined,
          stopPrice: order.auxPrice ?? undefined,
          status: 'pending',
          submittedAt: Date.now(),
        };
        pos.orders.push(appOrder);

        // Update SL/TP on the position object from real order data
        if (ibOrderType === 'STP' && order.auxPrice) {
          pos.stopLoss = order.auxPrice;
        }
        if (ibOrderType === 'LMT' && side === 'sell' && order.lmtPrice) {
          if (!pos.takeProfits.includes(order.lmtPrice)) {
            pos.takeProfits = [order.lmtPrice, ...pos.takeProfits.slice(1)];
          }
        }
      };

      const endHandler = () => {
        this.ib.off(EventName.openOrder, orderHandler);
        this.ib.off(EventName.openOrderEnd, endHandler);
        const total = Array.from(this.positions.values()).reduce((n, p) => n + p.orders.length, 0);
        logger.success('execution', `IBKR order sync complete — ${total} active order(s) attached`);
        resolve();
      };

      const ib2 = this.ib as unknown as { on: (e: string, h: unknown) => void; off: (e: string, h: unknown) => void; reqOpenOrders: () => void };
      ib2.on('openOrder', orderHandler);
      ib2.on('openOrderEnd', endHandler);
      this.ib.reqOpenOrders();

      setTimeout(() => {
        ib2.off('openOrder', orderHandler);
        ib2.off('openOrderEnd', endHandler);
        resolve();
      }, 10_000);
    });
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
      currency: 'USD',
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
      sessionHigh: entryPrice,
      tp1Hit: false,
      tp2Hit: false,
      slOrderId: slId,
      tp1OrderId: tpId,
    };

    this.positions.set(symbol, position);
    this.subscribePositionMktData(symbol);
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
      currency: 'USD',
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

  /**
   * Modify an existing stop order to a new price (cancel + replace).
   * IBKR supports in-place modification by reusing the same orderId.
   */
  adjustStop(symbol: string, newStopPrice: number): boolean {
    const pos = this.positions.get(symbol);
    if (!pos || !pos.slOrderId || this.orderIdBase === null) return false;

    const contract: Contract = { symbol, secType: SecType.STK, currency: 'USD', exchange: 'SMART' };
    const newStop = parseFloat(newStopPrice.toFixed(2));

    try {
      // IBKR modifies an order by placing it again with the same orderId
      this.ib.placeOrder(pos.slOrderId, contract, {
        orderId: pos.slOrderId,
        action: OrderAction.SELL,
        orderType: IBOrderType.STP,
        totalQuantity: pos.shares,
        auxPrice: newStop,
        tif: TimeInForce.GTC,
        transmit: true,
        account: this.account,
      });
      pos.stopLoss = newStop;
      logger.trade('execution', `${symbol}: stop adjusted to $${newStop.toFixed(2)}`);
      return true;
    } catch (err) {
      logger.error('execution', `adjustStop failed for ${symbol}: ${err}`);
      return false;
    }
  }

  /** Sell a partial number of shares at market price. */
  partialSell(symbol: string, sharesToSell: number, reason: string): boolean {
    const pos = this.positions.get(symbol);
    if (!pos || sharesToSell <= 0 || this.orderIdBase === null) return false;

    const qty = Math.min(sharesToSell, pos.shares);
    const orderId = this.orderIdBase + this.nextOrderIdOffset++;
    const contract: Contract = { symbol, secType: SecType.STK, currency: 'USD', exchange: 'SMART' };

    try {
      this.ib.placeOrder(orderId, contract, {
        orderId,
        action: OrderAction.SELL,
        orderType: IBOrderType.MKT,
        totalQuantity: qty,
        tif: TimeInForce.DAY,
        transmit: true,
        account: this.account,
      });

      const pnl = (pos.currentPrice - pos.avgPrice) * qty;
      pos.shares -= qty;
      pos.realizedPnl = (pos.realizedPnl ?? 0) + pnl;

      if (pos.shares <= 0) {
        pos.status = 'closed';
        pos.closedAt = Date.now();
        this.cancelPositionMktData(symbol);
      } else {
        // Adjust existing SL order quantity to match remaining shares
        if (pos.slOrderId) {
          const contract2: Contract = { symbol, secType: SecType.STK, currency: 'USD', exchange: 'SMART' };
          try {
            this.ib.placeOrder(pos.slOrderId, contract2, {
              orderId: pos.slOrderId,
              action: OrderAction.SELL,
              orderType: IBOrderType.STP,
              totalQuantity: pos.shares,
              auxPrice: pos.stopLoss,
              tif: TimeInForce.GTC,
              transmit: true,
              account: this.account,
            });
          } catch { /* non-fatal */ }
        }
      }

      logger.trade('execution', `${symbol}: partial sell ${qty} sh @ ~$${pos.currentPrice.toFixed(2)} — ${reason} | PnL $${pnl.toFixed(0)}`);
      return true;
    } catch (err) {
      logger.error('execution', `partialSell failed for ${symbol}: ${err}`);
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
    await this.ensureAccount();

    return new Promise((resolve, reject) => {
      const reqId = this.nextOrderIdOffset + 8000;
      const handler = (rId: number, _account: string, tag: string, value: string) => {
        if (rId !== reqId || tag !== 'NetLiquidation') return;
        this.ib.off(EventName.accountSummary, handler);
        this.ib.cancelAccountSummary(reqId);
        clearTimeout(timer);
        const liquidity = parseFloat(value);
        resolve(liquidity);
      };
      this.ib.on(EventName.accountSummary, handler);
      this.ib.reqAccountSummary(reqId, 'All', 'NetLiquidation');

      const timer = setTimeout(() => {
        this.ib.off(EventName.accountSummary, handler);
        this.ib.cancelAccountSummary(reqId);
        reject(new Error(`Account summary timed out — check TWS API permissions`));
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
