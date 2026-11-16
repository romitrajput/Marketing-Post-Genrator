import { useState } from 'react';
import { Button, ErrorBox, Spinner, TopNav } from '../components/ui';
import { DEMOS, demoUrl, loadDemo } from '../lib/demos';
import { navigate, setSession } from '../lib/session';

const STEPS = [
  ['Upload', 'JPG, PNG or WEBP you created or are allowed to use.'],
  ['Analyse', 'OpenCV.js + Tesseract.js run inside your browser.'],
  ['Decompose', 'Background, subject, objects, graphics and text become layers.'],
  ['Edit', 'Move, resize, recolour, rewrite text, fix masks by hand.'],
  ['Replace', 'Swap the subject or background with your own image.'],
  ['Export', 'PNG/JPEG at 1080×1080, 1080×1350, 1080×1920 or custom.'],
];

const FEATURES = [
  ['Approximate layer recovery', 'GrabCut, watershed, contours and inpainting rebuild an editable stack from a flat image — with an honest confidence label on every layer.'],
  ['Manual correction first-class', 'Rectangle, polygon, brush, eraser, invert and edge-snapping refinement for when automation gets it wrong.'],
  ['Text you can rewrite', 'OCR finds text lines; convert any of them into live text and change wording, font, size, colour and alignment.'],
  ['Replace the subject', 'Drop in your own product or model photo; the background is removed automatically and placed where the original was.'],
  ['Private by design', 'No uploads, no accounts, no servers. Images never leave your device; projects live in this browser.'],
  ['Zero cost', 'Open-source libraries only. Host it free on GitHub Pages or Cloudflare Pages.'],
];

export default function Landing() {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tryDemo = async (file: string) => {
    setBusy(file);
    setErr(null);
    try {
      const src = await loadDemo(file);
      setSession({ source: src, decomposition: undefined, openProjectId: undefined });
      navigate('analyse');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full">
      <TopNav />
      <main className="mx-auto max-w-6xl px-4">
        <section className="grid items-center gap-10 py-14 md:grid-cols-2 md:py-20">
          <div>
            <p className="mb-3 text-sm font-medium text-amber-700">Browser-only computer vision · ₹0 to run</p>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Turn a flat social media creative into editable layers.
            </h1>
            <p className="mt-4 max-w-lg text-lg text-stone-600">
              Upload a promotional image, let the studio separate background, subject and text, then replace what you need and
              export a new creative. No AI subscription, nothing uploaded.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button size="lg" variant="primary" onClick={() => navigate('upload')}>Upload an image</Button>
              <Button size="lg" onClick={() => tryDemo(DEMOS[1].file)} disabled={!!busy}>
                {busy === DEMOS[1].file ? <Spinner /> : null} Try the demo
              </Button>
            </div>
            <p className="mt-4 text-xs text-stone-500">
              Layers are reconstructed approximately — original Photoshop/Canva layers cannot be recovered from a flattened image.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {DEMOS.slice(0, 3).map((d, i) => (
              <img
                key={d.file} src={demoUrl(d.file)} alt={d.title}
                className={`aspect-[4/5] w-full rounded-xl object-cover shadow-lg ring-1 ring-stone-900/5 ${i === 1 ? 'translate-y-6' : ''}`}
              />
            ))}
          </div>
        </section>

        <section className="py-10" id="how">
          <h2 className="mb-6 text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="rounded-xl border border-stone-200 bg-white p-4">
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-900 text-xs text-white">{i + 1}</span>
                  {t}
                </div>
                <p className="text-sm text-stone-600">{d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="py-10">
          <h2 className="mb-2 text-2xl font-semibold tracking-tight">Sample demonstrations</h2>
          <p className="mb-5 text-stone-600">Five original test creatives. Pick one to run the full pipeline.</p>
          {err && <div className="mb-4"><ErrorBox>{err}</ErrorBox></div>}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {DEMOS.map((d) => (
              <button key={d.file} onClick={() => tryDemo(d.file)} disabled={!!busy} className="group text-left">
                <div className="relative overflow-hidden rounded-xl ring-1 ring-stone-200">
                  <img src={demoUrl(d.file)} alt={d.title} className="aspect-[4/5] w-full object-cover transition group-hover:scale-[1.02]" />
                  {busy === d.file && <div className="absolute inset-0 flex items-center justify-center bg-white/60"><Spinner /></div>}
                </div>
                <div className="mt-2 text-sm font-medium">{d.title}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="py-10">
          <h2 className="mb-6 text-2xl font-semibold tracking-tight">What you get</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([t, d]) => (
              <div key={t} className="rounded-xl border border-stone-200 bg-white p-5">
                <h3 className="font-medium">{t}</h3>
                <p className="mt-1 text-sm text-stone-600">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="border-t border-stone-200 py-8 text-sm text-stone-500">
          Proof of concept for 1–10 testers. Use only images you own or are permitted to edit. Projects are stored in this browser
          and are lost if you clear site data.
        </footer>
      </main>
    </div>
  );
}
