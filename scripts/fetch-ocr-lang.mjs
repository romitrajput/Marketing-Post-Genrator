// One-time download of the English OCR model (~10 MB) into public/tesseract/lang
// so a deployed copy never needs a third-party CDN. Free, no account required.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const out = join(root, 'public', 'tesseract', 'lang', 'eng.traineddata.gz');
mkdirSync(dirname(out), { recursive: true });
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed (${res.status}). The app will keep using the CDN at runtime.`);
  process.exit(1);
}
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log('Saved', out);
