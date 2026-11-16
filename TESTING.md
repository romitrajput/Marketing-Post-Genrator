# Testing checklist — Remix Studio PoC 0.1

Test on: desktop Chrome/Edge, desktop Firefox, desktop Safari (if available), one Android phone (Chrome).
Mark each item ✅ / ⚠️ (works with issues) / ❌ and note the device.

## A. Upload (Module 1)
- [ ] Drag & drop a JPG, a PNG and a WEBP — preview, dimensions, file size and type shown
- [ ] Browse files button works (also on Android)
- [ ] A .gif / .pdf / empty file is rejected with a clear message
- [ ] A file > 25 MB is rejected
- [ ] A 3000 px image shows the resize offer; resizing gives ≤ 2048 px
- [ ] A 5000 px image cannot be analysed until resized
- [ ] *Cancel upload* during reading; *Replace image*; *Remove*
- [ ] Each demo image loads

## B. Analysis & decomposition (Module 2)
- [ ] Steps show progress, timing and completion; the first run downloads engines (note the time)
- [ ] *Cancel* stops the run; *Re-run* works; *Retry* appears after a failure
- [ ] Turn the network off before the first run → clear error + *Manual mode* still works
- [ ] Detected-region overlay matches the layer list; hovering highlights a region
- [ ] Every layer has a confidence badge and a note; unticked layers don't appear in the studio

## C. Manual selection (Module 3)
- [ ] *Select from original image…*: rectangle, polygon (click first point / double-click / Enter), brush, eraser
- [ ] Subtract mode for rectangle/polygon; Invert; All; Clear; Undo (button and Ctrl/⌘+Z); brush size
- [ ] *Auto-detect object* and *Snap to edges* improve a rough selection
- [ ] *Preview cut-out* shows the transparent result; *Extract as new layer* adds it in the right place
- [ ] Option *Also remove it from the background* fills the hole
- [ ] *Select from selected layer…* + *Remove the selection from the source layer*

## D. Text (Module 4)
- [ ] OCR text appears in *Detected text*; *Convert to editable text* keeps position/colour roughly
- [ ] Edit wording, font, size, colour, bold/italic/underline, alignment, line height, letter spacing
- [ ] Double-click text on canvas to type directly
- [ ] *Delete original text* removes it, background underneath looks acceptable
- [ ] Text on a button/label: converting repaints the button under the old text
- [ ] *Add → Text* creates new text

## E. Editor (Module 5)
- [ ] Select via canvas and via layer list; rename (double-click); hide/show; lock/unlock (locked can't move or be deleted)
- [ ] Forward/backward/front/back and drag-to-reorder; duplicate; delete (button and Delete key)
- [ ] X/Y/W/H/angle fields, flips, opacity, arrow-key nudging (Shift = 10 px)
- [ ] Zoom (buttons, Ctrl/⌘+wheel), pan (wheel, Space+drag, Pan tool), click % to fit
- [ ] Undo/redo (buttons, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl/⌘+Y); *Reset* returns to the decomposed state
- [ ] *Preview* shows the clean composition
- [ ] Studio works when only 2–3 layers were detected and in manual mode (single layer)

## F. Replacement (Module 6)
- [ ] Main subject → *Replace…* → *Remove its background automatically* → fix → *Use this cut-out*
- [ ] Replacement sits at the original subject's position and size; text and graphics layers unchanged
- [ ] Resize/rotate/move, crop sliders, opacity, brightness, contrast
- [ ] *Match colours to the replaced layer*, *Edge feather*, *Drop shadow*
- [ ] *Use the whole image* and *Select the part to use manually* paths

## G. Background (Module 7)
- [ ] *Fill with colour*, *Use an image…* (cover-fit), *Make transparent* (export PNG keeps transparency)
- [ ] *Remove background…* on an added photo layer
- [ ] Saturation / temperature / Gaussian blur sliders on the background layer
- [ ] Hidden reconstructed background can be shown again in Layers

## H. Export (Module 8)
- [ ] PNG and JPEG (quality slider) at Original, 1080×1080, 1080×1350, 1080×1920, custom
- [ ] Different aspect ratio: fit + padding (colour or transparent), fill + crop, stretch
- [ ] Output is sharp (compare against original at 100%)
- [ ] *Download this layer as PNG*; *All layers as PNGs*
- [ ] Downloads work on Android Chrome

## I. Projects (IndexedDB)
- [ ] *Save* → appears in Projects with thumbnail; reopen restores all layers, edits and *Reset*
- [ ] Rename and delete from Projects; storage warning visible
- [ ] Reload the page with unsaved changes → browser warns
- [ ] Private/incognito window: saving either works for the session or shows a clear error

## J. Performance / robustness
- [ ] 2048 px image: analysis time on desktop ___ s, on Android ___ s
- [ ] UI stays responsive during OpenCV steps (spinner animates, Cancel works)
- [ ] No crash after 3 consecutive analyses; memory OK on phone

---

## PoC validation run (fill in per design type)

| Criterion | Fashion | Product | Restaurant | Event | Text-heavy |
|---|---|---|---|---|---|
| 1 Upload ordinary promo image | | | | | |
| 2 View original composition | | | | | |
| 3 Background + ≥1 foreground object separated | | | | | |
| 4 Manually corrected imperfect selection | | | | | |
| 5 Extracted object as transparent PNG | | | | | |
| 6 Text identified & edited independently | | | | | |
| 7 Foreground replaced with own image | | | | | |
| 8 Replacement repositioned & resized | | | | | |
| 9 Remaining composition preserved | | | | | |
| 10 Exported high-quality PNG | | | | | |
| Manual steps needed (count / what) | | | | | |

## Pre-browser results (Python mirror of the pipeline on the bundled demos)

Produced with `python3 scripts/pipeline-mirror.py public/demo/*` (same algorithm and parameters as the
browser worker; native OpenCV 5 + Tesseract 5.3 CLI instead of OpenCV.js/Tesseract.js, so numbers may differ slightly).
The graphics/shapes step was not mirrored.

| Demo | Main subject found | Confidence | Text lines read | Text missed / wrong | Background hole | Expected manual work |
|---|---|---|---|---|---|---|
| Fashion poster | Dress figure (16% of image) | High | NEW SEASON, Autumn Edit 2026; SHOP NOW via 2nd pass (with stray symbols) | "30% OFF" outline badge | 17.5% → Medium | Clean stray characters in button text; badge stays in background |
| Product ad | Bottle (13.5%) | High | All 5, incl. GLOW / vitamin C serum kept on the bottle | Logo "G" read as "@" | 15% → Medium | Background behind bottle smeared if subject moved — replace background |
| Restaurant post | Plate + burger (20%) | High | SMASH BURGER, Weekend special; Rs 249 via 2nd pass | — | 22% → Medium | Wood texture can't be rebuilt behind plate |
| Event announcement | Microphone head (2.2%) | Medium | OPEN MIC, NIGHT; date/venue only partly (text over yellow triangle) | "Fri 1…", "The Loft" | 5% → High | Mic stand base detected as separate object — merge via Refine mask; circle/triangle stay in background |
| Text-heavy promo | "VISIT STORE" button (no real subject) | Medium | All 8 lines (≥92% OCR confidence) | — | 7.6% → High | None for text editing |

**Reliable:** subject separation on flat/gradient backgrounds; OCR of clean horizontal text; text-on-object handling; full-resolution text removal.
**Needs manual help:** thin/outline graphics, text over multi-colour shapes, objects made of disconnected parts, large-area background reconstruction.
