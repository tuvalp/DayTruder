export const fmt = {
  currency: (v: number, decimals = 2) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(v),

  pct: (v: number, decimals = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`,

  time: (ts: number) =>
    new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),

  compact: (v: number) =>
    new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v),
};

export function pnlClass(v: number) {
  if (v > 0) return 'text-accent-green';
  if (v < 0) return 'text-accent-red';
  return 'text-gray-400';
}
