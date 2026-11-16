import { useState } from 'react';
import type { Editor } from '../editor/Editor';
import { downloadBlob, formatBytes, safeFileName } from '../lib/image';
import { Button, ErrorBox, Modal, Spinner } from './ui';

const PRESETS = [
  { key: 'original', label: 'Original size' },
  { key: '1080x1080', label: '1080 × 1080 (square post)', w: 1080, h: 1080 },
  { key: '1080x1350', label: '1080 × 1350 (portrait post)', w: 1080, h: 1350 },
  { key: '1080x1920', label: '1080 × 1920 (story / reel)', w: 1080, h: 1920 },
  { key: 'custom', label: 'Custom' },
] as const;

export default function ExportDialog({ editor, name, onClose }: { editor: Editor; name: string; onClose: () => void }) {
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [preset, setPreset] = useState<string>('original');
  const [cw, setCw] = useState(editor.docW);
  const [ch, setCh] = useState(editor.docH);
  const [fit, setFit] = useState<'contain' | 'cover' | 'stretch'>('contain');
  const [pad, setPad] = useState('#ffffff');
  const [transparentPad, setTransparentPad] = useState(true);
  const [quality, setQuality] = useState(0.92);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const p = PRESETS.find((x) => x.key === preset)!;
  const w = preset === 'original' ? editor.docW : preset === 'custom' ? cw : (p as { w: number }).w;
  const h = preset === 'original' ? editor.docH : preset === 'custom' ? ch : (p as { h: number }).h;
  const sameAspect = Math.abs(w / h - editor.docW / editor.docH) < 0.005;
  const tooBig = w * h > 8192 * 8192 || w < 16 || h < 16 || w > 8192 || h > 8192;

  const run = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const blob = await editor.exportComposition({
        format, quality, width: Math.round(w), height: Math.round(h), fit: sameAspect ? 'stretch' : fit,
        pad: format === 'png' && transparentPad ? '' : pad,
      });
      const file = `${safeFileName(name)}-${Math.round(w)}x${Math.round(h)}.${format === 'png' ? 'png' : 'jpg'}`;
      downloadBlob(blob, file);
      setDone(`Downloaded ${file} (${formatBytes(blob.size)}).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const exportAllLayers = async () => {
    setBusy(true);
    setErr(null);
    try {
      let n = 0;
      for (const row of editor.layers()) {
        if (!row.visible || row.meta.kind === 'original') continue;
        const b = await editor.exportLayer(row.obj);
        downloadBlob(b, `${safeFileName(name)}-layer-${String(++n).padStart(2, '0')}-${safeFileName(row.meta.name)}.png`);
        await new Promise((r) => setTimeout(r, 350)); // browsers throttle rapid multi-downloads
      }
      setDone(`Downloaded ${n} visible layer(s) as transparent PNGs.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <Button onClick={exportAllLayers} disabled={busy} className="mr-auto">All layers as PNGs</Button>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={run} disabled={busy || tooBig}>{busy ? <Spinner /> : null} Download</Button>
        </>
      }
    >
      <div className="space-y-4 p-4 text-sm">
        <div>
          <div className="mb-1 font-medium">Format</div>
          <div className="flex gap-2">
            {(['png', 'jpeg'] as const).map((f) => (
              <button key={f} onClick={() => setFormat(f)} className={`rounded-lg px-3 py-1.5 ring-1 ${format === f ? 'bg-stone-900 text-white ring-stone-900' : 'ring-stone-300'}`}>
                {f === 'png' ? 'PNG (lossless, transparency)' : 'JPEG (smaller)'}
              </button>
            ))}
          </div>
          {format === 'jpeg' && (
            <label className="mt-2 block text-xs text-stone-600">
              Quality {Math.round(quality * 100)}%
              <input type="range" min={0.5} max={1} step={0.01} value={quality} onChange={(e) => setQuality(parseFloat(e.target.value))} className="block w-full" />
            </label>
          )}
        </div>
        <div>
          <div className="mb-1 font-medium">Size</div>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full rounded-lg border border-stone-300 px-2 py-1.5">
            {PRESETS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          {preset === 'custom' && (
            <div className="mt-2 flex items-center gap-2">
              <input type="number" min={16} max={8192} value={cw} onChange={(e) => setCw(parseInt(e.target.value) || 0)} className="w-24 rounded border border-stone-300 px-2 py-1" /> ×
              <input type="number" min={16} max={8192} value={ch} onChange={(e) => setCh(parseInt(e.target.value) || 0)} className="w-24 rounded border border-stone-300 px-2 py-1" /> px
            </div>
          )}
          <p className="mt-1 text-xs text-stone-500">Composition is {editor.docW} × {editor.docH}px. Output {Math.round(w)} × {Math.round(h)}px.</p>
          {tooBig && <p className="text-xs text-rose-700">Choose a size between 16 and 8192px per side.</p>}
        </div>
        {!sameAspect && (
          <div>
            <div className="mb-1 font-medium">Aspect ratio differs — how to fit?</div>
            <div className="grid gap-1.5">
              <label className="flex items-center gap-2"><input type="radio" checked={fit === 'contain'} onChange={() => setFit('contain')} /> Fit inside, add padding (nothing cropped)</label>
              <label className="flex items-center gap-2"><input type="radio" checked={fit === 'cover'} onChange={() => setFit('cover')} /> Fill and crop edges</label>
              <label className="flex items-center gap-2"><input type="radio" checked={fit === 'stretch'} onChange={() => setFit('stretch')} /> Stretch (distorts)</label>
            </div>
            {fit === 'contain' && (
              <div className="mt-2 flex items-center gap-3 text-xs">
                Padding colour <input type="color" value={pad} onChange={(e) => setPad(e.target.value)} />
                {format === 'png' && <label className="flex items-center gap-1"><input type="checkbox" checked={transparentPad} onChange={(e) => setTransparentPad(e.target.checked)} /> transparent</label>}
              </div>
            )}
            <p className="mt-1 text-xs text-stone-500">Tip: for a proper re-layout, change the canvas size in the studio instead and rearrange layers.</p>
          </div>
        )}
        {err && <ErrorBox>{err}</ErrorBox>}
        {done && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">{done}</div>}
      </div>
    </Modal>
  );
}
