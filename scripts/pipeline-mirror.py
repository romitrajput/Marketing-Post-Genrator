"""Python mirror of the browser decomposition pipeline (src/workers/cv.worker.ts +
src/lib/textMask.ts). Used to tune parameters and record which operations work on
the demo creatives without a browser. Requires opencv-python, numpy, tesseract CLI.

    python3 scripts/pipeline-mirror.py public/demo/*.jpg public/demo/*.png
"""
import json
import subprocess
import sys

import cv2
import numpy as np

GC_BGD, GC_FGD, GC_PR_BGD, GC_PR_FGD = 0, 1, 2, 3


def ocr_lines(path):
    tsv = subprocess.run(["tesseract", path, "-", "tsv"], capture_output=True, text=True).stdout
    lines = {}
    for row in tsv.splitlines()[1:]:
        c = row.split("\t")
        if len(c) < 12 or c[0] != "5" or not c[11].strip():
            continue
        key = (c[2], c[3], c[4])
        x, y, w, h, conf = int(c[6]), int(c[7]), int(c[8]), int(c[9]), float(c[10])
        L = lines.setdefault(key, {"words": [], "x0": x, "y0": y, "x1": x + w, "y1": y + h, "conf": []})
        L["words"].append(c[11])
        L["conf"].append(conf)
        L["x0"], L["y0"] = min(L["x0"], x), min(L["y0"], y)
        L["x1"], L["y1"] = max(L["x1"], x + w), max(L["y1"], y + h)
    out = []
    for L in lines.values():
        text = " ".join(L["words"]).strip()
        conf = sum(L["conf"]) / len(L["conf"])
        if conf >= 55 and len(text.replace(" ", "")) >= 2:
            out.append({"text": text, "conf": conf, "box": [L["x0"], L["y0"], L["x1"] - L["x0"], L["y1"] - L["y0"]]})
    return out


def text_mask(img, box):
    """Mirror of textMask.ts: split text pixels from local background by colour."""
    x, y, w, h = box
    pad = max(2, int(h * 0.12))
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(img.shape[1], x + w + pad), min(img.shape[0], y + h + pad)
    patch = img[y0:y1, x0:x1].astype(np.float32)
    border = np.concatenate([patch[0], patch[-1], patch[:, 0], patch[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.linalg.norm(patch - bg, axis=2)
    far = dist >= np.percentile(dist, 85)
    fg = patch[far].mean(axis=0)
    contrast = float(np.linalg.norm(fg - bg))
    m = (np.linalg.norm(patch - fg, axis=2) < np.linalg.norm(patch - bg, axis=2)).astype(np.uint8)
    full = np.zeros(img.shape[:2], np.uint8)
    full[y0:y1, x0:x1] = m * 255
    return full, (x0, y0, x1 - x0, y1 - y0), contrast


def decompose(path):
    img = cv2.imread(path)
    H, W = img.shape[:2]
    lines = ocr_lines(path)
    text_all = np.zeros((H, W), np.uint8)
    text_boxes = np.zeros((H, W), np.uint8)
    for L in lines:
        m, pb, contrast = text_mask(img, L["box"])
        L["contrast"] = round(contrast)
        text_all |= m
        x, y, w, h = pb
        text_boxes[y:y + h, x:x + w] = 255

    # ---- foreground: GrabCut initialised with a mask ----
    s = min(1.0, 640 / max(W, H))
    a = cv2.resize(img, (round(W * s), round(H * s)), interpolation=cv2.INTER_AREA)
    h, w = a.shape[:2]
    mask = np.full((h, w), GC_PR_FGD, np.uint8)
    b = max(4, round(min(w, h) * 0.03))
    border_px = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3), a[:, :b].reshape(-1, 3), a[:, -b:].reshape(-1, 3)]).astype(np.float32)
    # dominant border colours via k-means (k=3)
    _, lab, cen = cv2.kmeans(border_px, 3, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0), 2, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(lab.ravel(), minlength=3)
    af = a.astype(np.float32)
    for k in range(3):
        if counts[k] / len(lab) > 0.15:
            near = np.linalg.norm(af - cen[k], axis=2) < 28
            mask[near] = GC_PR_BGD
    tb = cv2.resize(text_boxes, (w, h), interpolation=cv2.INTER_NEAREST) > 0
    mask[tb] = GC_PR_BGD
    mask[:b], mask[-b:], mask[:, :b], mask[:, -b:] = GC_BGD, GC_BGD, GC_BGD, GC_BGD
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(a, mask, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
    fg = np.where((mask == GC_FGD) | (mask == GC_PR_FGD), 255, 0).astype(np.uint8)
    k = lambda n: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (n, n))
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, k(3))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, k(7))
    # text interplay (mirror of worker step 3)
    glyph_s = cv2.dilate((cv2.resize(text_all, (w, h), interpolation=cv2.INTER_AREA) > 0).astype(np.uint8) * 255, k(3))
    on_obj = []
    for L in lines:
        x, y, ww, hh = [int(v * s) for v in L["box"]]
        pad = max(3, round(min(ww, hh) * 0.4))
        ring = fg[max(0, y - pad):y + hh + pad, max(0, x - pad):x + ww + pad].astype(bool).copy()
        inner = np.zeros_like(ring)
        oy, ox = y - max(0, y - pad), x - max(0, x - pad)
        inner[oy:oy + hh, ox:ox + ww] = True
        frac = ring[~inner].mean() if (~inner).any() else 0
        on_obj.append(bool(frac > 0.6))
        L["on_object"] = on_obj[-1]
    keep = np.zeros_like(fg, bool)
    for L, on in zip(lines, on_obj):
        if on:
            x, y, ww, hh = [int(v * s) for v in L["box"]]
            fg[y:y + hh, x:x + ww] = 255
            keep[y:y + hh, x:x + ww] = True
    fg[(glyph_s > 0) & ~keep] = 0
    n, cc, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=4)
    comps = sorted([(stats[i, cv2.CC_STAT_AREA], i) for i in range(1, n)], reverse=True)
    res = {"file": path.split("/")[-1], "text_lines": [(L["text"], round(L["conf"]), L["contrast"], L.get("on_object")) for L in lines]}
    if comps:
        area, idx = comps[0]
        main = (cc == idx).astype(np.uint8) * 255
        # watershed refine
        sure = cv2.erode(main, k(5), iterations=2)
        maybe = cv2.dilate(main, k(5), iterations=2)
        markers = np.where(sure > 0, 2, np.where(maybe > 0, 0, 1)).astype(np.int32)
        cv2.watershed(a, markers)
        ref = cv2.morphologyEx(((markers == 2) * 255).astype(np.uint8), cv2.MORPH_CLOSE, k(3))
        a0, a1 = (main > 0).sum(), (ref > 0).sum()
        ws = "used" if 0.85 * a0 < a1 < 1.15 * a0 else "rejected"
        if ws == "used":
            main = ref
        ratio = area / (w * h)
        mb = main > 0
        bt = (mb[:b + 1].sum() + mb[-b - 1:].sum() + mb[:, :b + 1].sum() + mb[:, -b - 1:].sum()) / (2 * (w + h) * (b + 1))
        conf = "high" if 0.04 < ratio < 0.7 and bt < 0.15 else ("medium" if 0.015 < ratio < 0.88 else "manual")
        x, y, ww, hh = cv2.boundingRect(main)
        res["main"] = {"area_ratio": round(float(ratio), 3), "border_touch": round(float(bt), 3), "confidence": conf, "watershed": ws,
                       "bbox_full": [round(v / s) for v in (x, y, ww, hh)]}
        res["secondary"] = [[round(v / s) for v in stats[i, :4]] for ar, i in comps[1:6] if ar / (w * h) > 0.006]
        # second-pass OCR on small secondary objects (sparse mode)
        extra = []
        for bx, by, bw, bh in res["secondary"]:
            crop = img[by:by + bh, bx:bx + bw]
            cv2.imwrite("/tmp/_c.png", crop)
            tsv = subprocess.run(["tesseract", "/tmp/_c.png", "-", "--psm", "11", "tsv"], capture_output=True, text=True).stdout
            words = [r.split("\t") for r in tsv.splitlines()[1:]]
            words = [c[11] for c in words if len(c) >= 12 and c[0] == "5" and c[11].strip() and float(c[10]) >= 60]
            if words:
                extra.append(" ".join(words))
        res["ocr_second_pass"] = extra
        # inpaint timing (mirror of worker inpaint)
        hole = np.zeros((H, W), np.uint8)
        full_main = cv2.resize(main, (W, H), interpolation=cv2.INTER_LINEAR) > 127
        hole[full_main] = 255
        hole[cv2.dilate(text_all, k(5), iterations=1) > 0] = 255
        import time
        big = hole.mean() / 255 > 0.12
        ss = min(1, (560 if big else 800) / max(W, H))
        t0 = time.time()
        hs = cv2.dilate((cv2.resize(hole, (round(W * ss), round(H * ss)), interpolation=cv2.INTER_AREA) > 0).astype(np.uint8) * 255, k(3), iterations=2)
        filled = cv2.inpaint(cv2.resize(img, (round(W * ss), round(H * ss)), interpolation=cv2.INTER_AREA), hs, 5, cv2.INPAINT_TELEA)
        res["inpaint"] = {"hole_pct": round(hole.mean() / 2.55, 1), "seconds_native": round(time.time() - t0, 2)}
        up = cv2.resize(filled, (W, H), interpolation=cv2.INTER_CUBIC)
        soft = cv2.GaussianBlur(cv2.dilate(hole, k(3), iterations=2), (7, 7), 0)[..., None] / 255.0
        bg = (img * (1 - soft) + up * soft).astype(np.uint8)
        cv2.imwrite("/tmp/bg-" + res["file"].split(".")[0] + ".png", bg)
        vis = a.copy()
        vis[main == 0] = (vis[main == 0] * 0.25).astype(np.uint8)
        cv2.imwrite("/tmp/mirror-" + res["file"].split(".")[0] + ".png", vis)
    return res


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(decompose(p), indent=1))
