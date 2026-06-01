import React from 'react';
import clsx from 'clsx';

interface Props {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean | null;  // null = neutral
  glow?: boolean;
}

export function MetricCard({ label, value, sub, positive, glow }: Props) {
  return (
    <div
      className={clsx(
        'bg-surface-1 border border-surface-2 rounded-xl p-4 flex flex-col gap-1 transition-all',
        glow && positive === true && 'glow-green border-accent-green/30',
        glow && positive === false && 'glow-red border-accent-red/30',
      )}
    >
      <p className="text-[10px] uppercase tracking-widest text-gray-500">{label}</p>
      <p
        className={clsx(
          'text-2xl font-bold tabular-nums',
          positive === true && 'text-accent-green',
          positive === false && 'text-accent-red',
          positive === null || positive === undefined ? 'text-white' : ''
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}
