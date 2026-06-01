import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import type { AppSettings } from '../types';

interface Props {
  settings: AppSettings;
  onSave: (patch: Partial<AppSettings>) => void;
  onReset: () => void;
}

interface FieldDef {
  key: keyof AppSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  section: 'risk' | 'scanner';
  description: string;
}

const FIELDS: FieldDef[] = [
  // Risk
  { key: 'maxRiskPerTradePct',  label: 'Max Risk / Trade',      min: 0.1,  max: 5,    step: 0.1, unit: '%',  section: 'risk',    description: 'Max % of account risked on a single trade' },
  { key: 'stopLossPct',         label: 'Stop-Loss',             min: 1,    max: 15,   step: 0.5, unit: '%',  section: 'risk',    description: 'Hard stop-loss below entry price' },
  { key: 'maxOpenPositions',    label: 'Max Open Positions',    min: 1,    max: 20,   step: 1,   unit: '',   section: 'risk',    description: 'Maximum simultaneous open positions' },
  { key: 'maxDailyLossPct',     label: 'Daily Loss Limit',      min: 1,    max: 20,   step: 0.5, unit: '%',  section: 'risk',    description: 'Circuit-breaker trips when daily loss hits this' },
  // Scanner
  { key: 'minPrice',            label: 'Min Price',             min: 0.1,  max: 50,   step: 0.1, unit: '$',  section: 'scanner', description: 'Ignore tickers below this price' },
  { key: 'maxPrice',            label: 'Max Price',             min: 1,    max: 100,  step: 1,   unit: '$',  section: 'scanner', description: 'Ignore tickers above this price' },
  { key: 'minRelativeVolume',   label: 'Min Relative Volume',   min: 1,    max: 20,   step: 0.5, unit: '×',  section: 'scanner', description: 'Minimum RVOL to qualify for an alert' },
  { key: 'maxFloatM',           label: 'Max Float',             min: 1,    max: 100,  step: 1,   unit: 'M',  section: 'scanner', description: 'Maximum shares float (millions)' },
  { key: 'minPriceSurgePct',    label: 'Min 1-min Surge',       min: 1,    max: 30,   step: 0.5, unit: '%',  section: 'scanner', description: 'Minimum 1-minute price surge to trigger alert' },
];

export function SettingsPanel({ settings, onSave, onReset }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sync when server pushes new settings
  useEffect(() => { setDraft(settings); setDirty(false); }, [settings]);

  function handleChange(key: keyof AppSettings, value: number) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  }

  function handleSave() {
    onSave(draft);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    onReset();
    setDirty(false);
  }

  const riskFields   = FIELDS.filter((f) => f.section === 'risk');
  const scannerFields = FIELDS.filter((f) => f.section === 'scanner');

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-2">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">Risk & Scanner Settings</p>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            className="px-3 py-1 text-[11px] rounded border border-surface-3 text-gray-400 hover:text-white hover:border-gray-400 transition-all"
          >
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty}
            className={clsx(
              'px-3 py-1 text-[11px] rounded border font-semibold transition-all',
              dirty
                ? 'border-accent-blue text-accent-blue hover:bg-accent-blue hover:text-white'
                : saved
                ? 'border-accent-green text-accent-green'
                : 'border-surface-3 text-gray-600 cursor-not-allowed'
            )}
          >
            {saved ? '✓ Saved' : 'Apply'}
          </button>
        </div>
      </div>

      <div className="p-4 grid grid-cols-2 gap-6">
        <Section label="Risk Management" fields={riskFields} draft={draft} onChange={handleChange} />
        <Section label="Scanner Thresholds" fields={scannerFields} draft={draft} onChange={handleChange} />
      </div>
    </div>
  );
}

function Section({
  label, fields, draft, onChange,
}: {
  label: string;
  fields: FieldDef[];
  draft: AppSettings;
  onChange: (key: keyof AppSettings, v: number) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 border-b border-surface-2 pb-1">{label}</p>
      {fields.map((f) => (
        <div key={f.key} className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-300">{f.label}</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={draft[f.key]}
                min={f.min}
                max={f.max}
                step={f.step}
                onChange={(e) => onChange(f.key, parseFloat(e.target.value))}
                className="w-16 bg-surface-2 border border-surface-3 rounded px-2 py-0.5 text-xs text-white text-right font-mono focus:outline-none focus:border-accent-blue"
              />
              <span className="text-[10px] text-gray-500 w-4">{f.unit}</span>
            </div>
          </div>
          <input
            type="range"
            min={f.min}
            max={f.max}
            step={f.step}
            value={draft[f.key]}
            onChange={(e) => onChange(f.key, parseFloat(e.target.value))}
            className="w-full h-1 accent-accent-blue cursor-pointer"
          />
          <p className="text-[10px] text-gray-600">{f.description}</p>
        </div>
      ))}
    </div>
  );
}
