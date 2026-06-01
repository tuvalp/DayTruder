import React from 'react';
import clsx from 'clsx';
import type { Position } from '../types';
import { fmt, pnlClass } from '../utils/format';

interface Props {
  positions: Position[];
}

export function PositionsTable({ positions }: Props) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">Open Positions</p>
        <span className="text-xs font-mono text-accent-blue">{positions.length} active</span>
      </div>

      {positions.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-xs text-gray-600 font-mono">
          No open positions
        </div>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[10px] text-gray-500 uppercase border-b border-surface-2">
              {['Ticker', 'Shares', 'Avg Price', 'Curr Price', 'Unr. P&L', 'Stop', 'TP1', 'Score'].map(
                (h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr
                key={p.id}
                className="border-b border-surface-2 last:border-0 hover:bg-surface-2 transition-colors"
              >
                <td className="px-4 py-2.5 font-bold text-accent-blue">{p.symbol}</td>
                <td className="px-4 py-2.5 text-gray-300">{p.shares}</td>
                <td className="px-4 py-2.5 text-gray-300">{fmt.currency(p.avgPrice)}</td>
                <td className="px-4 py-2.5 text-white">{fmt.currency(p.currentPrice)}</td>
                <td className={clsx('px-4 py-2.5 font-semibold', pnlClass(p.unrealizedPnl))}>
                  {fmt.currency(p.unrealizedPnl)}
                  <span className="ml-1 text-[10px] opacity-70">
                    ({fmt.pct(p.unrealizedPnlPct)})
                  </span>
                </td>
                <td className="px-4 py-2.5 text-accent-red">{fmt.currency(p.stopLoss)}</td>
                <td className="px-4 py-2.5 text-accent-green">
                  {fmt.currency(p.takeProfits[0] ?? 0)}
                </td>
                <td className="px-4 py-2.5">
                  <CatalystBadge score={p.catalystScore.score} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CatalystBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? 'text-accent-green bg-accent-green/10 border-accent-green/30'
    : score >= 60 ? 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/30'
    : 'text-accent-red bg-accent-red/10 border-accent-red/30';

  return (
    <span className={clsx('px-2 py-0.5 rounded border text-[10px] font-bold', color)}>
      {score}
    </span>
  );
}
