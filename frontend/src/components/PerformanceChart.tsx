import React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { format } from 'date-fns';
import type { PerformanceDataPoint } from '../types';

interface Props {
  data: PerformanceDataPoint[];
}

interface TooltipPayload {
  value: number;
  payload: PerformanceDataPoint;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-xs font-mono">
      <p className="text-gray-400">{format(d.timestamp, 'HH:mm:ss')}</p>
      <p className="text-white">Equity: ${d.equity.toLocaleString()}</p>
      <p className={d.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}>
        P&L: {d.pnl >= 0 ? '+' : ''}{d.pnl.toFixed(2)}%
      </p>
    </div>
  );
}

export function PerformanceChart({ data }: Props) {
  const hasData = data.length > 1;
  const lastPnl = data[data.length - 1]?.pnl ?? 0;
  const color = lastPnl >= 0 ? '#3fb950' : '#f85149';

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-3">
        Intraday Performance
      </p>

      {!hasData ? (
        <div className="flex items-center justify-center h-40 text-xs text-gray-600 font-mono">
          Waiting for market data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="timestamp"
              tickFormatter={(v) => format(v, 'HH:mm')}
              tick={{ fill: '#6b7280', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              dataKey="pnl"
              tickFormatter={(v) => `${v.toFixed(1)}%`}
              tick={{ fill: '#6b7280', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={50}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 4" />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke={color}
              strokeWidth={2}
              fill="url(#pnlGrad)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
