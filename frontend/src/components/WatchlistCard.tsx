import React from 'react';
import clsx from 'clsx';
import type { WatchlistEntry, SymbolStrategy } from '../types';
import { fmt } from '../utils/format';

interface Props {
  entries: WatchlistEntry[];
}

const STRATEGY_CONFIG: Record<SymbolStrategy, { label: string; class: string }> = {
  watching:    { label: 'Watching',    class: 'text-gray-500 bg-surface-3 border-surface-3' },
  alert:       { label: '🚨 Alert',    class: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/40' },
  researching: { label: '🔬 Research', class: 'text-accent-blue bg-accent-blue/10 border-accent-blue/40' },
  sizing:      { label: '⚖ Sizing',   class: 'text-accent-purple bg-accent-purple/10 border-accent-purple/40' },
  ordering:    { label: '⏳ Ordering', class: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/40' },
  positioned:  { label: '✅ In Trade', class: 'text-accent-green bg-accent-green/10 border-accent-green/40' },
  rejected:    { label: 'Rejected',    class: 'text-accent-red bg-accent-red/10 border-accent-red/30' },
};

export function WatchlistCard({ entries }: Props) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-2">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">Live Watchlist</p>
        <span className="text-xs font-mono text-accent-blue">{entries.length} symbols</span>
      </div>

      {entries.length === 0 ? (
        <div className="flex items-center justify-center h-14 text-xs text-gray-600 font-mono">
          Waiting for screener…
        </div>
      ) : (
        <div className="overflow-y-auto max-h-52">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[10px] text-gray-600 uppercase border-b border-surface-2">
                <th className="px-3 py-1.5 text-left">Symbol</th>
                <th className="px-3 py-1.5 text-right">Price</th>
                <th className="px-3 py-1.5 text-right">Chg%</th>
                <th className="px-3 py-1.5 text-right">RVOL</th>
                <th className="px-3 py-1.5 text-left">Strategy</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const cfg = STRATEGY_CONFIG[e.strategy];
                const isActive = e.strategy !== 'watching' && e.strategy !== 'rejected';
                return (
                  <tr
                    key={e.symbol}
                    className={clsx(
                      'border-b border-surface-2 last:border-0 transition-colors',
                      isActive ? 'bg-surface-2' : 'hover:bg-surface-2'
                    )}
                  >
                    <td className={clsx('px-3 py-1.5 font-bold', isActive ? 'text-white' : 'text-gray-400')}>
                      {e.symbol}
                    </td>
                    <td className="px-3 py-1.5 text-right text-white">
                      {e.price > 0 ? fmt.currency(e.price) : '—'}
                    </td>
                    <td className={clsx('px-3 py-1.5 text-right font-semibold', e.changePercent >= 0 ? 'text-accent-green' : 'text-accent-red')}>
                      {e.price > 0 ? fmt.pct(e.changePercent) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-400">
                      {e.relVol > 0 ? `${e.relVol.toFixed(1)}×` : '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={clsx('px-2 py-0.5 rounded border text-[10px]', cfg.class)}>
                        {cfg.label}
                      </span>
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
