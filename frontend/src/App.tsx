import React, { useState } from 'react';
import clsx from 'clsx';
import { useSocket } from './hooks/useSocket';
import { Header } from './components/Header';
import { MetricCard } from './components/MetricCard';
import { PerformanceChart } from './components/PerformanceChart';
import { PositionsTable } from './components/PositionsTable';
import { AgentTerminal } from './components/AgentTerminal';
import { SettingsPanel } from './components/SettingsPanel';
import { WatchlistCard } from './components/WatchlistCard';
import { ManualBuy } from './components/ManualBuy';
import { fmt } from './utils/format';

type Tab = 'dashboard' | 'settings';

export default function App() {
  const { connected, agentState, portfolio, performance, logs, settings, watchlist, startAgent, pauseAgent, updateSettings } =
    useSocket();

  const [tab, setTab] = useState<Tab>('dashboard');

  const pnl = portfolio?.dailyRealizedPnl ?? 0;
  const unrealPnl = portfolio?.dailyUnrealizedPnl ?? 0;
  const totalPnl = pnl + unrealPnl;

  function handleReset() {
    fetch('/api/settings/reset', { method: 'POST' });
  }

  return (
    <div className="flex flex-col h-screen bg-surface overflow-hidden">
      <Header
        connected={connected}
        agentState={agentState}
        onStart={startAgent}
        onPause={pauseAgent}
      />

      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-2 border-b border-surface-2 bg-surface-1">
        {(['dashboard', 'settings'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              'px-4 py-1.5 text-xs font-medium rounded-t transition-all capitalize',
              tab === t
                ? 'text-white border-b-2 border-accent-blue'
                : 'text-gray-500 hover:text-gray-300'
            )}
          >
            {t === 'settings' ? '⚙ Settings' : '◈ Dashboard'}
          </button>
        ))}
      </div>

      {/* Dashboard tab */}
      {tab === 'dashboard' && (
        <div className="flex flex-1 gap-3 p-3 overflow-hidden min-h-0">
          <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden">
            <div className="grid grid-cols-3 gap-3 shrink-0">
              <MetricCard
                label="Net Liquidity"
                value={fmt.currency(portfolio?.netLiquidity ?? 0, 0)}
                sub="Total portfolio value"
                positive={null}
              />
              <MetricCard
                label="Daily P&L"
                value={fmt.currency(totalPnl)}
                sub={`Realized ${fmt.currency(pnl)} · Unr. ${fmt.currency(unrealPnl)}`}
                positive={totalPnl > 0 ? true : totalPnl < 0 ? false : null}
                glow
              />
              <MetricCard
                label="Active Risk Multiplier"
                value={`${((portfolio?.activeRiskMultiplier ?? 1) * 100).toFixed(0)}%`}
                sub={`${portfolio?.openPositions.length ?? 0} open · max ${settings.maxOpenPositions}`}
                positive={(portfolio?.activeRiskMultiplier ?? 1) > 0.7 ? true : false}
              />
            </div>
            <div className="shrink-0">
              <WatchlistCard entries={watchlist} />
            </div>
            <div className="shrink-0">
              <PerformanceChart data={performance} />
            </div>
            <div className="shrink-0">
              <ManualBuy />
            </div>
            <div className="flex-1 overflow-auto min-h-0">
              <PositionsTable positions={portfolio?.openPositions ?? []} />
            </div>
          </div>
          <div className="w-[420px] shrink-0 flex flex-col min-h-0">
            <AgentTerminal logs={logs} />
          </div>
        </div>
      )}

      {/* Settings tab */}
      {tab === 'settings' && (
        <div className="flex-1 overflow-auto p-4">
          <div className="max-w-4xl mx-auto">
            <SettingsPanel
              settings={settings}
              onSave={updateSettings}
              onReset={handleReset}
            />
          </div>
        </div>
      )}
    </div>
  );
}
