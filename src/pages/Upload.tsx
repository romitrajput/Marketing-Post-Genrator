import { useCallback, useRef, useState } from 'react';
import { Button, ErrorBox, Spinner, TopNav } from '../components/ui';
import { DEMOS, demoUrl, loadDemo } from '../lib/demos';
import { MAX_PROCESS_SIDE, formatBytes, readSource, resizeBlob, validateFile } from '../lib/image';
import { singleLayer } from '../lib/decompose';
import { navigate, setSession, useSession } from '../lib/session';
import type { SourceImage } from '../lib/types';

export default function UploadPage() {
  const session = useSession();
  const [src, setSrc] = useState<SourceImage | null>(session.source ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const token = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const accept = useCallback(async (file: File | Blob, name: string) => {
    setErr(null);
    if (file instanceof File) {
      const v = validateFile(file);
      if (v) return setErr(v);
    }
    const my = ++token.current;
    setLoading(name);
    try {
      const s = await readSource(file, name);
      if (my !== token.current) return URL.revokeObjectURL(s.url); // cancelled
      setSrc(s);
    } catch (e) {
      if (my === token.current) setErr((e as Error).message);
    } finally {
      if (my === token.current) setLoading(null);
    }
  }, []);

  const cancel = () => {
    token.current++;
    setLoading(null);
  };
  const clear = () => {
    cancel();
    setSrc(null);
    setErr(null);
    setSession({ source: undefined, decomposition: undefined });
  };

  const tooLarge = !!src && Math.max(src.width, src.height) > MAX_PROCESS_SIDE;
  const mustResize = !!src && Math.max(src.width, src.height) > MAX_PROCESS_SIDE * 2;

  const resize = async () => {
    if (!src) return;
    setLoading('resizing');
    try {
      const blob = await resizeBlob(src, MAX_PROCESS_SIDE);
      const s = await readSource(blob, src.name);
      setSrc(s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(null);
    }
  };

  const go = (manual: boolean) => {
    if (!src) return;
    setSession({ source: src, decomposition: manual ? singleLayer(src) : undefined, openProjectId: undefined });
    navigate(manual ? 'studio' : 'analyse');
  };

  return (
    <div className="min-h-full">
      <TopNav />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Upload an image</h1>
        <p className="mt-1 text-stone-600">One image at a time. JPG, PNG or WEBP, up to 25 MB. It stays on this device.</p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void accept(f, f.name);
          }}
          className={`mt-6 rounded-2xl border-2 border-dashed p-6 transition ${drag ? 'border-amber-500 bg-amber-50' : 'border-stone-300 bg-white'}`}
        >
          <input
            ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void accept(f, f.name);
              e.target.value = '';
            }}
          />
          {!src && !loading && (
            <div className="flex flex-col items-center py-10 text-center">
              <div className="mb-3 text-4xl">⬆︎</div>
              <p className="font-medium">Drag & drop an image here</p>
              <p className="mb-4 text-sm text-stone-500">or</p>
              <Button variant="primary" onClick={() => input.current?.click()}>Browse files</Button>
            </div>
          )}
          {loading && (
            <div className="flex flex-col items-center gap-3 py-12">
              <Spinner />
              <p className="text-sm text-stone-600">{loading === 'resizing' ? 'Resizing…' : `Reading ${loading}…`}</p>
              <Button size="sm" onClick={cancel}>Cancel upload</Button>
            </div>
          )}
          {src && !loading && (
            <div className="grid gap-6 md:grid-cols-[1fr_260px]">
              <div className="checker flex max-h-[60vh] items-center justify-center overflow-hidden rounded-xl">
                <img src={src.url} alt="Preview" className="max-h-[60vh] max-w-full object-contain" />
              </div>
              <div className="space-y-4 text-sm">
                <dl className="space-y-1.5">
                  <div className="flex justify-between gap-2"><dt className="text-stone-500">File</dt><dd className="truncate font-medium" title={src.name}>{src.name}</dd></div>
                  <div className="flex justify-between"><dt className="text-stone-500">Dimensions</dt><dd className="font-medium tabular-nums">{src.width} × {src.height}px</dd></div>
                  <div className="flex justify-between"><dt className="text-stone-500">File size</dt><dd className="font-medium tabular-nums">{formatBytes(src.bytes)}</dd></div>
                  <div className="flex justify-between"><dt className="text-stone-500">Type</dt><dd className="font-medium">{src.type.replace('image/', '').toUpperCase()}</dd></div>
                </dl>
                {tooLarge && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                    This image is larger than {MAX_PROCESS_SIDE}px. {mustResize ? 'It must be resized before processing.' : 'Processing it may be slow or run out of memory on phones.'}
                    <Button size="sm" className="mt-2 w-full" onClick={resize}>Resize to {MAX_PROCESS_SIDE}px (recommended)</Button>
                  </div>
                )}
                <div className="space-y-2">
                  <Button variant="primary" className="w-full" disabled={mustResize} onClick={() => go(false)}>Analyse & decompose →</Button>
                  <Button className="w-full" disabled={mustResize} onClick={() => go(true)}>Skip analysis (manual mode)</Button>
                  <div className="flex gap-2">
                    <Button className="flex-1" onClick={() => input.current?.click()}>Replace image</Button>
                    <Button variant="danger" onClick={clear}>Remove</Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        {err && <div className="mt-4"><ErrorBox>{err}</ErrorBox></div>}

        <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wider text-stone-500">Or use a demonstration image</h2>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {DEMOS.map((d) => (
            <button
              key={d.file} className="text-left"
              onClick={async () => {
                const my = ++token.current;
                setLoading(d.file);
                try {
                  const s = await loadDemo(d.file);
                  if (my === token.current) setSrc(s);
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  if (my === token.current) setLoading(null);
                }
              }}
            >
              <img src={demoUrl(d.file)} alt={d.title} className="aspect-[4/5] w-full rounded-lg object-cover ring-1 ring-stone-200 hover:ring-stone-400" />
              <div className="mt-1 text-xs text-stone-600">{d.title}</div>
            </button>
          ))}
        </div>
        <p className="mt-8 text-xs text-stone-500">
          Instagram import is intentionally not supported. Download images you are allowed to use and upload them here.
        </p>
      </main>
    </div>
  );
}
