import React, { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { format } from 'date-fns';
import type { AgentLogEntry } from '../types';

interface Props {
  logs: AgentLogEntry[];
}

const LEVEL_STYLES: Record<AgentLogEntry['level'], string> = {
  info:    'text-gray-400',
  warn:    'text-accent-yellow',
  error:   'text-accent-red',
  success: 'text-accent-green',
  trade:   'text-accent-blue font-semibold',
};

const MODULE_COLOR: Record<AgentLogEntry['module'], string> = {
  scanner:   'text-accent-purple',
  research:  'text-accent-yellow',
  risk:      'text-accent-red',
  execution: 'text-accent-blue',
  system:    'text-gray-500',
};

export function AgentTerminal({ logs }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl flex flex-col h-full min-h-0">
      {/* Terminal header bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-2 shrink-0">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-accent-red/70" />
          <span className="w-3 h-3 rounded-full bg-accent-yellow/70" />
          <span className="w-3 h-3 rounded-full bg-accent-green/70" />
        </div>
        <p className="text-[10px] uppercase tracking-widest text-gray-500 ml-2">
          AlphaAgent — Autonomous Log
        </p>
        <span className="ml-auto text-[10px] font-mono text-gray-600">{logs.length} entries</span>
      </div>

      {/* Log body */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-5 space-y-0.5">
        {logs.length === 0 && (
          <p className="text-gray-700">{'>'} Waiting for agent events…</p>
        )}
        {logs.map((entry) => (
          <div key={entry.id} className="flex gap-2 hover:bg-surface-2 rounded px-1 transition-colors">
            <span className="text-gray-600 shrink-0">
              {format(entry.timestamp, 'HH:mm:ss')}
            </span>
            <span className={clsx('uppercase text-[10px] shrink-0 w-9', MODULE_COLOR[entry.module])}>
              [{entry.module.slice(0, 3).toUpperCase()}]
            </span>
            <span className={LEVEL_STYLES[entry.level]}>{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
