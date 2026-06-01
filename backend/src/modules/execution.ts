import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { Order, Position, PositionSizing, CatalystScore, OrderStatus } from '../types';

interface AlpacaOrderResponse {
  id: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
}

/**
 * Order Execution Module
 *
 * Submits bracket orders (entry + stop-loss + take-profit) to Alpaca.
 * Tracks open positions and polls for fill status.
 *
 * Bracket order structure (Alpaca OCA group):
 *  - Entry: Market or Limit buy
 *  - Leg 1 (stop-loss): Stop order
 *  - Leg 2 (first TP): Limit sell of full position
 *
 * For multi-tier TPs we submit individual limit sells after the bracket fills.
 */
export class ExecutionModule {
  private http: AxiosInstance;
  private positions = new Map<string, Position>();
  private fillPoller: NodeJS.Timeout | null = null;

  constructor() {
    this.http = axios.create({
      baseURL: config.ALPACA_BASE_URL + '/v2',
      headers: {
        'APCA-API-KEY-ID': config.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
  }

  async submitBracketOrder(
    sizing: PositionSizing,
    catalyst: CatalystScore
  ): Promise<Position | null> {
    const { symbol, shares, entryPrice, stopLoss, takeProfits } = sizing;

    logger.trade('execution', `Submitting bracket order: BUY ${shares} ${symbol} @ ~$${entryPrice.toFixed(2)}`);

    const orderPayload = {
      symbol,
      qty: shares.toString(),
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      limit_price: (entryPrice * 1.005).toFixed(2),  // 0.5% slippage buffer
      order_class: 'bracket',
      stop_loss: { stop_price: stopLoss.toFixed(2) },
      take_profit: { limit_price: takeProfits[0].toFixed(2) },  // first TP
    };

    let brokerResp: AlpacaOrderResponse;
    try {
      const { data } = await this.http.post<AlpacaOrderResponse>('/orders', orderPayload);
      brokerResp = data;
    } catch (err) {
      const msg = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : String(err);
      logger.error('execution', `Order rejected by broker: ${msg}`);
      return null;
    }

    const entryOrder: Order = {
      id: uuidv4(),
      brokerOrderId: brokerResp.id,
      symbol,
      side: 'buy',
      type: 'limit',
      quantity: shares,
      limitPrice: entryPrice * 1.005,
      stopPrice: undefined,
      status: this.mapStatus(brokerResp.status),
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
    logger.success('execution', `Position opened: ${symbol} — bracket order ID ${brokerResp.id}`);
    return position;
  }

  async closePosition(symbol: string): Promise<boolean> {
    const position = this.positions.get(symbol);
    if (!position) {
      logger.warn('execution', `closePosition: no open position for ${symbol}`);
      return false;
    }

    try {
      await this.http.delete(`/positions/${symbol}`);
      position.status = 'closed';
      position.closedAt = Date.now();
      this.positions.delete(symbol);
      logger.trade('execution', `Position closed (market): ${symbol}`);
      return true;
    } catch (err) {
      const msg = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : String(err);
      logger.error('execution', `Failed to close ${symbol}: ${msg}`);
      return false;
    }
  }

  /** Fetch live position data from broker and sync local state. */
  async syncPositions(): Promise<void> {
    try {
      const { data } = await this.http.get<AlpacaPositionResponse[]>('/positions');
      for (const pos of data) {
        const local = this.positions.get(pos.symbol);
        if (local) {
          local.currentPrice = parseFloat(pos.current_price);
          local.unrealizedPnl = parseFloat(pos.unrealized_pl);
          local.unrealizedPnlPct = parseFloat(pos.unrealized_plpc) * 100;
        }
      }
    } catch (err) {
      logger.warn('execution', 'Failed to sync positions from broker.');
    }
  }

  /** Fetch account equity from Alpaca. */
  async getAccountLiquidity(): Promise<number> {
    const { data } = await this.http.get<{ portfolio_value: string }>('/account');
    return parseFloat(data.portfolio_value);
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'open');
  }

  private mapStatus(alpacaStatus: string): OrderStatus {
    const map: Record<string, OrderStatus> = {
      new: 'pending',
      partially_filled: 'partially_filled',
      filled: 'filled',
      canceled: 'cancelled',
      rejected: 'rejected',
      expired: 'cancelled',
    };
    return map[alpacaStatus] ?? 'pending';
  }
}

interface AlpacaPositionResponse {
  symbol: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}
