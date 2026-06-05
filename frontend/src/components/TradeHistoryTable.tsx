import React from 'react';
import clsx from 'clsx';
import type { TradeExecution } from '../types';
import { fmt, pnlClass } from '../utils/format';

interface Props {
  executions: TradeExecution[];
}

export function TradeHistoryTable({ executions }: Props) {
  const sorted = [...executions].sort((a, b) => b.timestamp - a.timestamp);

  const totalRealizedPnl = executions.reduce((s, e) => s + e.realizedPnl, 0);
  const totalCommission  = executions.reduce((s, e) => s + e.commission, 0);
  const sells = executions.filter((e) => e.side === 'sell');
  const wins  = sells.filter((e) => e.realizedPnl > 0).length;
  const winRate = sells.length > 0 ? ((wins / sells.length) * 100).toFixed(0) : '—';

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-0 border-b border-surface-2">
        {[
          { label: 'Realized P&L',  value: fmt.currency(totalRealizedPnl), positive: totalRealizedPnl > 0 ? true : totalRealizedPnl < 0 ? false : null },
          { label: 'Commission',    value: fmt.currency(-totalCommission),  positive: false },
          { label: 'Net P&L',       value: fmt.currency(totalRealizedPnl - totalCommission), positive: (totalRealizedPnl - totalCommission) > 0 ? true : (totalRealizedPnl - totalCommission) < 0 ? false : null },
          { label: 'Win Rate',      value: sells.length ? `${winRate}% (${wins}/${sells.length})` : '—', positive: null },
        ].map((m) => (
          <div key={m.label} className="px-4 py-3 border-r border-surface-2 last:border-0">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">{m.label}</p>
            <p className={clsx(
              'text-sm font-mono font-semibold',
              m.positive === true ? 'text-accent-green' : m.positive === false ? 'text-accent-red' : 'text-white'
            )}>{m.value}</p>
          </div>
        ))}
      </div>

      <div className="px-4 py-2.5 border-b border-surface-2 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">Trade History (Today)</p>
        <span className="text-xs font-mono text-accent-blue">{executions.length} fills</span>
      </div>

      {executions.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-xs text-gray-600 font-mono">
          No executions today — trades appear here as they fill
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase border-b border-surface-2">
                {['Time', 'Symbol', 'Side', 'Shares', 'Price', 'Value', 'Realized P&L', 'Commission', 'Net'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const value  = e.shares * e.price;
                const net    = e.realizedPnl - e.commission;
                return (
                  <tr key={e.id} className="border-b border-surface-2 last:border-0 hover:bg-surface-2 transition-colors">
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-2 font-bold text-accent-blue">{e.symbol}</td>
                    <td className={clsx('px-3 py-2 font-semibold uppercase', e.side === 'buy' ? 'text-accent-green' : 'text-accent-red')}>
                      {e.side}
                    </td>
                    <td className="px-3 py-2 text-gray-300">{e.shares}</td>
                    <td className="px-3 py-2 text-white">{fmt.currency(e.price)}</td>
                    <td className="px-3 py-2 text-gray-400">{fmt.currency(value, 0)}</td>
                    <td className={clsx('px-3 py-2 font-semibold', e.side === 'buy' ? 'text-gray-500' : pnlClass(e.realizedPnl))}>
                      {e.side === 'buy' ? '—' : fmt.currency(e.realizedPnl)}
                    </td>
                    <td className="px-3 py-2 text-accent-red">
                      {e.commission > 0 ? fmt.currency(-e.commission) : '—'}
                    </td>
                    <td className={clsx('px-3 py-2 font-semibold', e.side === 'buy' ? 'text-gray-500' : pnlClass(net))}>
                      {e.side === 'buy' ? '—' : fmt.currency(net)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
