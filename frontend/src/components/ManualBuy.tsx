import React, { useState } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000';

export function ManualBuy() {
  const [symbol, setSymbol] = useState('');
  const [price, setPrice] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!symbol || !price) return;
    setStatus('loading');
    try {
      const r = await axios.post(`${API}/agent/manual-buy`, {
        symbol: symbol.toUpperCase().trim(),
        price: parseFloat(price),
      });
      setMsg(r.data.message);
      setStatus('ok');
      setTimeout(() => setStatus('idle'), 3000);
    } catch (err) {
      setMsg(axios.isAxiosError(err) ? err.response?.data?.error ?? 'Request failed' : String(err));
      setStatus('error');
      setTimeout(() => setStatus('idle'), 4000);
    }
  }

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-3">Manual Buy — Test Pipeline</p>
      <form onSubmit={handleSubmit} className="flex gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500">Symbol</label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. AAPL"
            className="w-24 bg-surface-2 border border-surface-3 rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-accent-blue uppercase"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500">Price $</label>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="5.00"
            type="number"
            step="0.01"
            min="0"
            className="w-24 bg-surface-2 border border-surface-3 rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-accent-blue"
          />
        </div>
        <button
          type="submit"
          disabled={status === 'loading' || !symbol || !price}
          className="px-4 py-1.5 rounded border border-accent-blue text-accent-blue text-xs font-semibold hover:bg-accent-blue hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {status === 'loading' ? '…' : '▶ Trigger'}
        </button>
        {status === 'ok'    && <span className="text-xs text-accent-green">{msg}</span>}
        {status === 'error' && <span className="text-xs text-accent-red">{msg}</span>}
      </form>
      <p className="text-[10px] text-gray-600 mt-2">
        Bypasses scanner — runs Claude research → risk sizing → IBKR order.
      </p>
    </div>
  );
}
