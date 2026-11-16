// Copies the OpenCV.js and Tesseract.js runtime files from node_modules into
// public/ so the app serves them itself (no CDN at runtime, works offline once loaded).
// Runs automatically after `npm install`.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const pub = join(root, 'public');
let ok = true;

function pkgDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    const guess = join(root, 'node_modules', name);
    return existsSync(guess) ? guess : null;
  }
}

// OpenCV.js (single file, WASM embedded)
const cvDir = pkgDir('@techstark/opencv-js');
const cvSrc = cvDir && [join(cvDir, 'dist', 'opencv.js'), join(cvDir, 'opencv.js')].find(existsSync);
if (cvSrc) {
  mkdirSync(join(pub, 'opencv'), { recursive: true });
  copyFileSync(cvSrc, join(pub, 'opencv', 'opencv.js'));
  console.log('[copy-assets] opencv.js ->', 'public/opencv/opencv.js');
} else {
  ok = false;
  console.warn('[copy-assets] WARNING: @techstark/opencv-js not found; the app will fall back to the OpenCV CDN.');
}

// Tesseract worker + core (WASM)
const tDir = pkgDir('tesseract.js');
const coreDir = pkgDir('tesseract.js-core');
mkdirSync(join(pub, 'tesseract', 'core'), { recursive: true });
const workerSrc = tDir && join(tDir, 'dist', 'worker.min.js');
if (workerSrc && existsSync(workerSrc)) {
  copyFileSync(workerSrc, join(pub, 'tesseract', 'worker.min.js'));
  console.log('[copy-assets] tesseract worker -> public/tesseract/worker.min.js');
} else ok = false;
if (coreDir) {
  const files = readdirSync(coreDir).filter((f) => f.startsWith('tesseract-core'));
  for (const f of files) copyFileSync(join(coreDir, f), join(pub, 'tesseract', 'core', f));
  console.log(`[copy-assets] ${files.length} tesseract core files -> public/tesseract/core/`);
  if (!files.length) ok = false;
} else ok = false;

if (!existsSync(join(pub, 'tesseract', 'lang', 'eng.traineddata.gz'))) {
  console.log('[copy-assets] OCR language data not bundled yet. Run `npm run fetch-ocr-lang` once to self-host it;');
  console.log('              otherwise it is downloaded from the free jsDelivr CDN on first OCR run and cached by the browser.');
}
if (!ok) console.warn('[copy-assets] Some runtime files were missing; CDN fallbacks will be used.');
