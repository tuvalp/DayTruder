import React from 'react';

interface Props {
  symbols: string[];
}

export function WatchlistCard({ symbols }: Props) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-2">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">Live Watchlist</p>
        <span className="text-xs font-mono text-accent-blue">{symbols.length} symbols</span>
      </div>

      {symbols.length === 0 ? (
        <div className="flex items-center justify-center h-16 text-xs text-gray-600 font-mono">
          Waiting for screener…
        </div>
      ) : (
        <div className="p-3 flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
          {symbols.map((sym) => (
            <span
              key={sym}
              className="px-2 py-0.5 rounded bg-surface-2 border border-surface-3 text-[11px] font-mono text-accent-blue"
            >
              {sym}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
