import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ConfidenceBadge, ErrorBox, Spinner, TopNav } from '../components/ui';
import { DECOMPOSE_STEPS, decompose, singleLayer } from '../lib/decompose';
import { resetOpenCV } from '../lib/cvClient';
import { navigate, setSession, useSession } from '../lib/session';
import type { Decomposition, LayerKind, StepState } from '../lib/types';

export const KIND_COLOR: Record<LayerKind, string> = {
  background: '#78716c', subject: '#f59e0b', object: '#0ea5e9', graphic: '#8b5cf6', shape: '#ec4899',
  text: '#10b981', image: '#64748b', original: '#a8a29e',
};

export default function AnalysePage() {
  const { source, decomposition } = useSession();
  const [steps, setSteps] = useState<StepState[]>(() =>
    DECOMPOSE_STEPS.map((s) => ({ ...s, status: decomposition ? 'done' : 'pending' })),
  );
  const [result, setResult] = useState<Decomposition | null>(decomposition ?? null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  const run = useCallback(async () => {
    if (!source) return;
    signal.current.cancelled = true;
    const sig = { cancelled: false };
    signal.current = sig;
    setSteps(DECOMPOSE_STEPS.map((s) => ({ ...s })));
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      const r = await decompose(source, (key, patch) => {
        if (!sig.cancelled) setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
      }, sig);
      if (!sig.cancelled) {
        setResult(r);
        setSession({ decomposition: r });
      }
    } catch (e) {
      if (!sig.cancelled) setError((e as Error).message);
    } finally {
      if (!sig.cancelled) setRunning(false);
    }
  }, [source]);

  useEffect(() => {
    if (source && !decomposition) void run();
    return () => {
      signal.current.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!source) {
    return (
      <div className="min-h-full">
        <TopNav />
        <main className="mx-auto max-w-xl px-4 py-20 text-center">
          <p className="mb-4 text-stone-600">No image loaded.</p>
          <Button variant="primary" onClick={() => navigate('upload')}>Upload an image</Button>
        </main>
      </div>
    );
  }

  const cancel = () => {
    signal.current.cancelled = true;
    resetOpenCV(); // abort the in-flight OpenCV job
    setRunning(false);
    setError('Analysis cancelled.');
  };
  const toggle = (id: string) => {
    if (!result) return;
    const r = { ...result, layers: result.layers.map((l) => (l.id === id ? { ...l, include: !l.include } : l)) };
    setResult(r);
    setSession({ decomposition: r });
  };
  const manual = () => {
    setSession({ decomposition: singleLayer(source) });
    navigate('studio');
  };

  const shown = result?.layers.filter((l) => l.kind !== 'original') ?? [];
  const counts = shown.reduce<Record<string, number>>((a, l) => ((a[l.confidence] = (a[l.confidence] ?? 0) + 1), a), {});

  return (
    <div className="min-h-full">
      <TopNav />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Analysis & decomposition</h1>
            <p className="text-stone-600">{source.name} · {source.width}×{source.height}px · everything runs on this device</p>
          </div>
          <div className="flex gap-2">
            {running ? <Button onClick={cancel}>Cancel</Button> : <Button onClick={run}>Re-run analysis</Button>}
            <Button onClick={manual}>Manual mode</Button>
            <Button variant="primary" disabled={!result} onClick={() => navigate('studio')}>Open in studio →</Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div>
            <div className="checker relative mx-auto w-fit overflow-hidden rounded-xl ring-1 ring-stone-200">
              <img src={source.url} alt="" className="block max-h-[70vh] w-auto max-w-full" />
              {showBoxes && result && (
                <svg viewBox={`0 0 ${result.docW} ${result.docH}`} className="pointer-events-none absolute inset-0 h-full w-full">
                  {shown.filter((l) => l.include && l.kind !== 'background').map((l) => (
                    <g key={l.id}>
                      <rect
                        x={l.box.x} y={l.box.y} width={l.box.w} height={l.box.h} fill={hover === l.id ? KIND_COLOR[l.kind] + '33' : 'none'}
                        stroke={KIND_COLOR[l.kind]} strokeWidth={Math.max(2, result.docW / 300)} strokeDasharray={l.confidence === 'manual' ? '8 6' : undefined}
                      />
                    </g>
                  ))}
                </svg>
              )}
            </div>
            {result && (
              <label className="mt-3 flex items-center justify-center gap-2 text-sm text-stone-600">
                <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} /> Show detected regions
              </label>
            )}
          </div>

          <div className="space-y-4">
            <ol className="space-y-1.5 rounded-xl border border-stone-200 bg-white p-3">
              {steps.map((s) => (
                <li key={s.key} className="text-sm">
                  <div className="flex items-center gap-2">
                    <StepIcon status={s.status} />
                    <span className={s.status === 'pending' ? 'text-stone-400' : ''}>{s.label}</span>
                  </div>
                  {s.status === 'running' && s.progress !== undefined && s.progress > 0 && s.progress < 1 && (
                    <div className="ml-6 mt-1 h-1 overflow-hidden rounded bg-stone-200">
                      <div className="h-full bg-stone-900 transition-all" style={{ width: `${s.progress * 100}%` }} />
                    </div>
                  )}
                  {s.detail && <div className={`ml-6 text-xs ${s.status === 'failed' ? 'text-rose-700' : s.status === 'skipped' ? 'text-amber-700' : 'text-stone-400'}`}>{s.detail}</div>}
                </li>
              ))}
            </ol>
            {running && <p className="text-xs text-stone-500">First run downloads the CV engine (~10 MB) and OCR model (~10 MB); later runs use the browser cache.</p>}
            {error && (
              <ErrorBox onRetry={run}>
                {error}
                <div className="mt-1 text-xs">You can retry, or continue in manual mode and select objects yourself.</div>
              </ErrorBox>
            )}

            {result && (
              <div className="rounded-xl border border-stone-200 bg-white">
                <div className="border-b border-stone-200 px-3 py-2 text-sm">
                  <div className="font-medium">{shown.length} approximate layers</div>
                  <div className="text-xs text-stone-500">
                    {counts.high ?? 0} high · {counts.medium ?? 0} medium · {counts.manual ?? 0} need manual correction. Untick layers you don't want.
                  </div>
                </div>
                <ul className="scroll-thin max-h-[48vh] divide-y divide-stone-100 overflow-auto">
                  {[...shown].reverse().map((l) => (
                    <li key={l.id} className="flex gap-3 px-3 py-2" onMouseEnter={() => setHover(l.id)} onMouseLeave={() => setHover(null)}>
                      <input type="checkbox" className="mt-1" checked={l.include} onChange={() => toggle(l.id)} aria-label={`Include ${l.name}`} />
                      <div className="checker flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded ring-1 ring-stone-200">
                        <img src={l.url} alt="" className="max-h-full max-w-full object-contain" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[l.kind] }} />
                          <span className="truncate text-sm font-medium">{l.name}</span>
                        </div>
                        <div className="mt-0.5"><ConfidenceBadge c={l.confidence} /></div>
                        {l.note && <p className="mt-1 text-xs text-stone-500">{l.note}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result && (
              <details className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
                <summary className="cursor-pointer font-medium text-stone-700">Technical log</summary>
                <ul className="mt-2 list-disc space-y-0.5 pl-4">{result.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </details>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StepIcon({ status }: { status: StepState['status'] }) {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5" />;
  const m = { pending: ['○', 'text-stone-300'], done: ['✓', 'text-emerald-600'], failed: ['✕', 'text-rose-600'], skipped: ['!', 'text-amber-600'] } as const;
  const [c, cls] = m[status];
  return <span className={`inline-flex w-3.5 justify-center text-sm font-bold ${cls}`}>{c}</span>;
}
