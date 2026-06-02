import React from 'react';
import clsx from 'clsx';
import type { Order } from '../types';
import { fmt } from '../utils/format';

interface Props { orders: Order[] }

const STATUS_CLASS: Record<string, string> = {
  pending:          'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/30',
  filled:           'text-accent-green  bg-accent-green/10  border-accent-green/30',
  partially_filled: 'text-accent-blue   bg-accent-blue/10   border-accent-blue/30',
  cancelled:        'text-gray-500      bg-surface-3        border-surface-3',
  rejected:         'text-accent-red    bg-accent-red/10    border-accent-red/30',
};

const TYPE_LABEL: Record<string, string> = {
  limit: 'LMT', market: 'MKT', stop: 'STP', stop_limit: 'STP-LMT',
};

export function OrdersTable({ orders }: Props) {
  const active = orders.filter((o) => o.status === 'pending' || o.status === 'partially_filled');
  const recent = orders.filter((o) => o.status !== 'pending' && o.status !== 'partially_filled').slice(-10);
  const display = [...active, ...recent];

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">Orders</p>
        <span className="text-xs font-mono text-accent-blue">{active.length} active</span>
      </div>

      {display.length === 0 ? (
        <div className="flex items-center justify-center h-16 text-xs text-gray-600 font-mono">
          No orders
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase border-b border-surface-2">
                {['Symbol', 'Side', 'Type', 'Qty', 'Price', 'Filled', 'Status', 'Time'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.map((o) => (
                <tr key={o.id} className="border-b border-surface-2 last:border-0 hover:bg-surface-2 transition-colors">
                  <td className="px-3 py-2 font-bold text-accent-blue">{o.symbol}</td>
                  <td className={clsx('px-3 py-2 font-semibold uppercase', o.side === 'buy' ? 'text-accent-green' : 'text-accent-red')}>
                    {o.side}
                  </td>
                  <td className="px-3 py-2 text-gray-400">{TYPE_LABEL[o.type] ?? o.type}</td>
                  <td className="px-3 py-2 text-gray-300">{o.quantity}</td>
                  <td className="px-3 py-2 text-white">
                    {o.stopPrice
                      ? `STP ${fmt.currency(o.stopPrice)}`
                      : o.limitPrice
                      ? fmt.currency(o.limitPrice)
                      : 'MKT'}
                  </td>
                  <td className="px-3 py-2 text-gray-400">
                    {o.filledQty != null ? `${o.filledQty}` : '—'}
                    {o.avgFillPrice ? ` @ ${fmt.currency(o.avgFillPrice)}` : ''}
                  </td>
                  <td className="px-3 py-2">
                    <span className={clsx('px-2 py-0.5 rounded border text-[10px]', STATUS_CLASS[o.status] ?? STATUS_CLASS.pending)}>
                      {o.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-[10px]">
                    {new Date(o.submittedAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
