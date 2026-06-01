import React from 'react';
import { useSocket } from './hooks/useSocket';
import { Header } from './components/Header';
import { MetricCard } from './components/MetricCard';
import { PerformanceChart } from './components/PerformanceChart';
import { PositionsTable } from './components/PositionsTable';
import { AgentTerminal } from './components/AgentTerminal';
import { fmt } from './utils/format';

export default function App() {
  const { connected, agentState, portfolio, performance, logs, startAgent, pauseAgent } =
    useSocket();

  const pnl = portfolio?.dailyRealizedPnl ?? 0;
  const unrealPnl = portfolio?.dailyUnrealizedPnl ?? 0;
  const totalPnl = pnl + unrealPnl;

  return (
    <div className="flex flex-col h-screen bg-surface overflow-hidden">
      <Header
        connected={connected}
        agentState={agentState}
        onStart={startAgent}
        onPause={pauseAgent}
      />

      {/* Main grid */}
      <div className="flex flex-1 gap-3 p-3 overflow-hidden min-h-0">
        {/* Left / centre column */}
        <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden">
          {/* Metric cards row */}
          <div className="grid grid-cols-3 gap-3 shrink-0">
            <MetricCard
              label="Net Liquidity"
              value={fmt.currency(portfolio?.netLiquidity ?? 0, 0)}
              sub="Total portfolio value"
              positive={null}
            />
            <MetricCard
              label="Daily Realized P&L"
              value={fmt.currency(pnl)}
              sub={`Unrealized: ${fmt.currency(unrealPnl)}`}
              positive={totalPnl > 0 ? true : totalPnl < 0 ? false : null}
              glow
            />
            <MetricCard
              label="Active Risk Multiplier"
              value={`${((portfolio?.activeRiskMultiplier ?? 1) * 100).toFixed(0)}%`}
              sub={`${portfolio?.openPositions.length ?? 0} open positions`}
              positive={(portfolio?.activeRiskMultiplier ?? 1) > 0.7 ? true : false}
            />
          </div>

          {/* Performance chart */}
          <div className="shrink-0">
            <PerformanceChart data={performance} />
          </div>

          {/* Positions table — scrollable */}
          <div className="flex-1 overflow-auto min-h-0">
            <PositionsTable positions={portfolio?.openPositions ?? []} />
          </div>
        </div>

        {/* Right column — terminal */}
        <div className="w-[420px] shrink-0 flex flex-col min-h-0">
          <AgentTerminal logs={logs} />
        </div>
      </div>
    </div>
  );
}
