import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Confidence } from '../lib/types';
import { navigate } from '../lib/session';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const v = {
    primary: 'bg-stone-900 text-white hover:bg-stone-800 disabled:bg-stone-400',
    secondary: 'bg-white text-stone-800 border border-stone-300 hover:bg-stone-100 disabled:text-stone-400',
    ghost: 'text-stone-700 hover:bg-stone-200/70 disabled:text-stone-300',
    danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50 disabled:text-red-300',
  }[variant];
  const s = { sm: 'h-8 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm', lg: 'h-11 px-5 text-base' }[size];
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${v} ${s} ${className}`}
      {...rest}
    />
  );
}

export function ConfidenceBadge({ c }: { c?: Confidence }) {
  if (!c) return null;
  const map = {
    high: ['High confidence', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
    medium: ['Medium confidence', 'bg-amber-50 text-amber-700 ring-amber-200'],
    manual: ['Manual correction required', 'bg-rose-50 text-rose-700 ring-rose-200'],
  } as const;
  const [label, cls] = map[c];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${cls}`}>{label}</span>;
}

export function ConfidenceDot({ c }: { c?: Confidence }) {
  if (!c) return <span className="inline-block h-2 w-2" />;
  const cls = { high: 'bg-emerald-500', medium: 'bg-amber-500', manual: 'bg-rose-500' }[c];
  const t = { high: 'High confidence', medium: 'Medium confidence', manual: 'Manual correction required' }[c];
  return <span title={t} className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

export function Slider({
  label, value, min, max, step = 0.01, onChange, onCommit, format,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; onCommit?: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="mb-0.5 flex justify-between text-[11px] text-stone-500">
        <span>{label}</span>
        <span className="tabular-nums">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range" className="w-full" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

export function NumberField({ label, value, onChange, step = 1, min }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs focus-within:border-stone-400">
      <span className="w-4 shrink-0 text-stone-400">{label}</span>
      <input
        type="number" step={step} min={min} value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-full min-w-0 bg-transparent tabular-nums outline-none"
      />
    </label>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-stone-200 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">{title}</h3>
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${wide ? 'max-w-6xl h-full' : 'max-w-lg'}`}>
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button className="rounded-md p-1 text-stone-500 hover:bg-stone-100" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-900 ${className}`} />;
}

export function Logo() {
  return (
    <button onClick={() => navigate('home')} className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="relative inline-block h-6 w-6 rounded-md bg-stone-900">
        <span className="absolute left-1 top-1 h-2.5 w-2.5 rounded-sm bg-amber-400" />
        <span className="absolute bottom-1 right-1 h-2.5 w-2.5 rounded-sm bg-white/85" />
      </span>
      Remix Studio
      <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium text-stone-600">PoC 0.1</span>
    </button>
  );
}

export function TopNav({ children }: { children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-stone-200 bg-stone-50/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Logo />
        <nav className="flex items-center gap-1">
          {children}
          <Button variant="ghost" onClick={() => navigate('projects')}>Projects</Button>
          <Button variant="primary" onClick={() => navigate('upload')}>Upload image</Button>
        </nav>
      </div>
    </header>
  );
}

export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      <div>{children}</div>
      {onRetry && <Button size="sm" variant="danger" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** Opens a native file picker and resolves with the chosen file (or null). */
export function pickFile(accept = 'image/jpeg,image/png,image/webp'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // resolves null if the dialog is dismissed (supported browsers)
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
