# Remix Studio — zero-budget computer-vision visual remix PoC (v0.1)

Upload a flattened social-media creative, decompose it into **approximate** editable layers
(background, main subject, secondary objects, graphics/shapes, text), fix the masks by hand,
replace the subject/background/text, and export a new creative — entirely in the browser.

- **₹0 to run.** No backend, no accounts, no paid APIs, no generative AI. Static hosting only.
- **Private.** Images never leave the device. Projects live in the browser's IndexedDB.
- **Honest.** Every detected layer carries a confidence label (High / Medium / Manual correction required).
  Original Photoshop/Canva layers cannot be recovered from a flat image; this rebuilds an approximation.

---

## 1. Quick start

Requirements: Node.js 18.18+ (20 LTS recommended) and npm. Python 3 is only needed to regenerate demo images.

```bash
npm install            # also copies OpenCV.js + Tesseract runtime into public/ (scripts/copy-assets.mjs)
npm run fetch-ocr-lang # optional, one-time: self-host the English OCR model (~10 MB)
npm run dev            # http://localhost:5173
```

Production build:

```bash
npm run build          # type-checks, then outputs static files to dist/
npm run preview        # serve dist/ locally to test the production build
```

After your first successful `npm install`, commit the generated `package-lock.json` so builds are reproducible.

## 2. Deployment (free)

The build is a static folder with relative paths and hash routing, so it runs from any sub-path.

**GitHub Pages**
1. Push this folder to a GitHub repository (branch `main`).
2. Repository → Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
3. The included workflow `.github/workflows/deploy.yml` builds and publishes on every push to `main`.
   The site appears at `https://<user>.github.io/<repo>/`.

**Cloudflare Pages (free tier)** — Create project → connect the repo → Build command
`npm install && npm run fetch-ocr-lang && npm run build`, output directory `dist`.

No environment variables or secrets are needed.

## 3. How it works

```
Upload → Analyse → Decompose → Edit → Replace → Reconstruct → Export
```

| Step | Technique (all client-side) |
|---|---|
| Text detection | Tesseract.js line OCR; a second *sparse-text* pass inside small objects (buttons, badges, price tags). Glyph pixels are separated from their local background by colour distance. |
| Main subject | OpenCV.js **GrabCut** initialised with a mask: border = background, pixels similar to the dominant border colours (JS k-means) = probable background, text boxes = probable background. Morphological open/close, connected components, then **watershed** refinement of the boundary (kept only if sane). |
| Secondary objects | Remaining large GrabCut components. |
| Graphics / shapes | Canny edges → dilation/closing → external contours, excluding subject and text; classified as *shape* (flat colour) or *graphic/logo*. |
| Text on objects | Text whose surroundings are foreground (e.g. a label on a bottle, a button caption) stays part of that object. Converting it to editable text repaints the object underneath with its local colour. |
| Background | Two-scale inpainting: large object holes with TELEA at reduced resolution (blended with a feathered mask), text holes at full resolution box by box (keeps edges crisp). |
| Manual selection | Rectangle, polygon, brush, eraser, invert, select-all/clear, undo, preview, **Snap to edges** (mask-initialised GrabCut), **Auto-detect** (GrabCut). |
| Editing | Fabric.js canvas: layers, stacking, lock/visibility, transforms, crop, opacity, brightness/contrast/saturation/temperature/blur filters, shadow, edge feathering, colour matching (mean/std transfer), undo/redo. |
| Export | PNG/JPEG at original size, 1080×1080, 1080×1350, 1080×1920 or custom (fit+pad, fill+crop, or stretch), individual layers as transparent PNG. |

OpenCV runs in a Web Worker (`src/workers/cv.worker.ts`); Tesseract runs in its own worker.

## 4. Folder structure

```
remix-studio/
├─ index.html
├─ package.json / vite.config.ts / tsconfig.json
├─ public/
│  ├─ demo/                    5 original sample creatives (generated, freely usable)
│  ├─ opencv/  tesseract/      runtime files copied by `npm install` (git-ignored)
├─ scripts/
│  ├─ copy-assets.mjs          copies opencv.js + tesseract worker/core into public/
│  ├─ fetch-ocr-lang.mjs       one-time download of eng.traineddata.gz
│  ├─ make-demos.py            regenerates the demo images
│  └─ pipeline-mirror.py       Python/OpenCV mirror of the decomposition pipeline (for tuning/testing)
├─ src/
│  ├─ App.tsx, main.tsx, index.css
│  ├─ pages/        Landing, Upload, Analyse (decomposition), Studio (editor), Projects
│  ├─ components/   MaskEditor, LayerPanel, PropertiesPanel, ExportDialog, ui
│  ├─ editor/       Editor.ts — Fabric.js wrapper (layers, history, export, replace, crop, filters)
│  ├─ workers/      cv.worker.ts — GrabCut, watershed, contours, inpainting, mask refinement
│  └─ lib/          decompose pipeline, OCR, text masks, OpenCV client, IndexedDB, projects, raster ops
└─ .github/workflows/deploy.yml
```

## 5. Cost & licences (no mandatory paid dependency)

| Package | Licence | Notes |
|---|---|---|
| React, React DOM | MIT | |
| Fabric.js 6 | MIT | |
| @techstark/opencv-js (OpenCV 4.10) | Apache-2.0 | Self-hosted from `public/opencv/` |
| Tesseract.js 5 + tesseract.js-core | Apache-2.0 | Self-hosted from `public/tesseract/` |
| eng.traineddata (tessdata) | Apache-2.0 | Self-hosted after `npm run fetch-ocr-lang`, otherwise loaded once from the free jsDelivr CDN and browser-cached |
| Vite, Tailwind CSS, TypeScript | MIT / Apache-2.0 | Build-time only |

All are free for commercial use. Apache-2.0 requires keeping licence/NOTICE files when you redistribute;
they ship inside `node_modules` and the copied runtime files keep their headers.
**Fallbacks:** if the self-hosted files are missing, OpenCV falls back to `docs.opencv.org` and Tesseract to jsDelivr.
Both are free public CDNs, but for a fully self-contained deployment run `npm install` + `npm run fetch-ocr-lang` before building.

## 6. Technical limitations (please read before testing)

- **Layers are approximations.** Works best on designs with a clearly separated subject on a flat or gradient background.
  Busy photographic backgrounds, subjects touching the image edge and low-contrast subjects need manual correction.
- **Background reconstruction is basic.** Inpainting fills small holes well; large holes (a person covering 20% of the image)
  come out smeared. Replace the background with a colour/image instead — that path is fully supported.
- **Shadows and overlays** are not separated into their own layers; they stay in the background or subject.
- **Fonts are not recovered.** Converted text uses browser fonts (Arial, Georgia, Impact, …). Size and colour are estimated.
- **OCR** is English only; stylised, curved, vertical or very small text is often missed — add text manually.
- **Logos** are found heuristically (edges/contours), not recognised.
- **Performance:** images are limited to 2048 px on the longest side for processing (larger uploads are offered a resize;
  above 4096 px resizing is required). First analysis downloads ~20 MB of engines (cached afterwards).
  Mask preparation and cut-outs run on the main thread and may pause the UI for a moment on slow phones.
- **Mobile:** upload, analysis, preview and export work on Android browsers; editing is desktop-first.
  Pinch-to-zoom on the canvas is not implemented (use the zoom buttons / Pan tool).
- **Storage:** projects are kept in this browser only and are lost if site data is cleared.
- **Not included by design:** Instagram import/scraping, accounts, cloud storage, AI generation.

## 7. Minimum functional workflow (validation path)

1. Open the app → *Try the demo* (or upload a JPG/PNG/WEBP).
2. Analysis page: watch the steps; review detected layers and confidence; untick unwanted layers → **Open in studio**.
3. Select *Main subject* → **Refine mask** to correct it (brush/eraser/Snap to edges) → Apply.
4. With the subject selected → **Download this layer as PNG** (transparent cut-out).
5. Select a text layer → **Convert to editable text** → change the wording, font, size, colour.
6. Select *Main subject* → **Replace…** → pick your image → *Remove its background automatically* → fix → Use.
7. Drag/resize the replacement; optionally *Match colours*, *Edge feather*, *Drop shadow*.
8. **Export** → PNG → 1080 × 1350 (or any preset) → Download. **Save** to keep the project in this browser.

See [TESTING.md](TESTING.md) for the full checklist and the results template for the five design types.

## 8. Verification status of this build

The pipeline parameters were tuned with `scripts/pipeline-mirror.py`, a Python/OpenCV mirror of the
browser pipeline, on the five bundled demo creatives (results in TESTING.md). The pure-JS helpers
(text mask, k-means, connected components, fallback inpainting) were unit-run in Node, and the source
type-checks. **The complete app has not yet been run end-to-end in a browser in the environment it was
written in** (package installation was unavailable there): the first `npm install && npm run dev` is the
first real run — work through TESTING.md and report anything that misbehaves.
