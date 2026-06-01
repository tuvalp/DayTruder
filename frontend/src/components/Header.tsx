import React from 'react';
import clsx from 'clsx';
import type { AgentState } from '../types';

interface Props {
  connected: boolean;
  agentState: AgentState;
  onStart: () => void;
  onPause: () => void;
}

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Idle',
  scanning: 'Scanning',
  researching: 'Researching',
  executing: 'Executing Trade',
  monitoring: 'Monitoring',
  paused: 'Paused',
};

export function Header({ connected, agentState, onStart, onPause }: Props) {
  const isLive = agentState !== 'paused' && agentState !== 'idle';

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-surface-2 bg-surface-1">
      {/* Logo */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-accent-blue flex items-center justify-center glow-blue">
          <span className="text-xs font-bold text-surface">AA</span>
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-wide text-white">AlphaAgent AI</h1>
          <p className="text-[10px] text-gray-500 tracking-widest uppercase">Autonomous Trading System</p>
        </div>
      </div>

      {/* Centre — agent state badge */}
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'w-2 h-2 rounded-full',
            isLive ? 'bg-accent-green animate-pulse' : 'bg-gray-500'
          )}
        />
        <span className="text-xs font-mono text-gray-300">
          {STATE_LABELS[agentState]}
        </span>
        <span className="text-xs text-gray-600 ml-2">
          {connected ? '● WS connected' : '○ WS disconnected'}
        </span>
      </div>

      {/* Toggle button */}
      <button
        onClick={isLive ? onPause : onStart}
        className={clsx(
          'px-4 py-1.5 rounded-md text-xs font-semibold transition-all border',
          isLive
            ? 'border-accent-red text-accent-red hover:bg-accent-red hover:text-white'
            : 'border-accent-green text-accent-green hover:bg-accent-green hover:text-white glow-green'
        )}
      >
        {isLive ? '⏸  Pause Agent' : '▶  Start Agent'}
      </button>
    </header>
  );
}
