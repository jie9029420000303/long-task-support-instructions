#!/usr/bin/env node
// 長頁像素比對：換版時證明「沒受影響的畫面跟前一版完全相同」，才能沿用前一版的肉眼查核（共用規格不變量 7）。
// 用法：
//   node pixel-diff.js capture <網址或本機 HTML> <輸出目錄> --widths 320,768,1440 [--height 900] [--wait 毫秒]
//                      [--mask <選擇器>]... [--track <選擇器>]... [--revision <版本或雜湊>]
//   node pixel-diff.js compare <前一版目錄> <本版目錄> [--affected <選擇器或標籤>]... [--out <報告目錄>]
// capture：每種寬度截一張完整長頁（縮放固定 1 倍、動畫直接跑到結束、游標隱藏、等字型與圖片載入），
//          記下頁首、各區段、頁尾、有 id 或 data-component 的元素與 --track 元素的位置，寫進 manifest.json。
//          每一版都留著，當下一版的比對基準，舊版不必重新部署。輪播、時間這類每次都會變的區塊用 --mask 遮掉。
// compare：逐像素比對，門檻為零，一個像素不同就算有差。每種寬度判成 identical（完全相同）、
//          inside（差異只在 --affected 範圍內）、outside（範圍外也有差異）、missing（缺這個寬度）。
//          頁高不同時，從上、下各自對齊，找出真正變動的那一段。報告與標色差異圖寫進本版目錄（或 --out），不覆蓋舊檔。
// 結束碼：0＝每種寬度都是 identical 或 inside；1＝有 outside 或 missing，needsReverify 列出要併入重驗的區塊；
//         2＝本機沒有 playwright 或 chrome-headless-shell；3＝參數或輸入檔有誤；4＝截圖過程失敗。
// 這支工具只證明「沒變」。有差異的區塊仍要由視覺查核子代理親眼看，比對結果不代替看畫面。
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const USAGE = "用法：node pixel-diff.js capture <網址或本機 HTML> <輸出目錄> --widths 320,768,1440 [--height 900] [--wait 毫秒] [--mask 選擇器]... [--track 選擇器]... [--revision 版本]\n" +
  "      node pixel-diff.js compare <前一版目錄> <本版目錄> [--affected 選擇器或標籤]... [--out 報告目錄]";
const CHUNK = 4000;
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LANDMARKS = "header,nav,main,footer,section,article,aside,[id],[data-component],[data-section]";
const MAX_BOXES = 3000;
const VERDICT_LABEL = {
  identical: "完全相同，可沿用前一版查核",
  inside: "差異只在受影響範圍內；範圍外可沿用前一版查核",
  outside: "受影響範圍外也有差異，列出的區塊要併入重驗",
  missing: "缺少這個寬度的長頁，整頁要重驗",
};
const OVERALL_LABEL = {
  identical: "所有寬度完全相同",
  inside: "所有差異都在受影響範圍內",
  outside: "有範圍外差異或缺少寬度，needsReverify 列出的區塊要併入重驗",
};

class InputError extends Error {}

function findPlaywright() {
  const root = path.join(os.homedir(), ".npm", "_npx");
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, "node_modules", "playwright");
      if (fs.existsSync(p)) return p;
    }
  }
  try { return require.resolve("playwright"); } catch (_) { return null; }
}
function findHeadlessShell() {
  const base = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const linux = path.join(os.homedir(), ".cache", "ms-playwright");
  for (const root of [base, linux]) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac", "chrome-headless-shell-linux", "chrome-linux"]) {
        const exe = path.join(root, d, sub, "chrome-headless-shell");
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 只讀 8 位元 RGB／RGBA、不交錯的 PNG（Chromium 截圖與本工具輸出都是這種），轉成 RGBA。
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new InputError("不是 PNG 檔");
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new InputError("不支援的 PNG 格式（位元深度 " + depth + "、色彩類型 " + colorType + "、交錯 " + interlace + "）");
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new InputError("PNG 資料長度不足");
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const f = raw[start];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = raw[start + 1 + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new InputError("PNG 濾波類型 " + f + " 不正確");
      cur[i] = v & 0xff;
    }
    if (bpp === 4) cur.copy(out, y * width * 4);
    else for (let x = 0, o = y * width * 4; x < width; x++, o += 4) { out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255; }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, data: out };
}
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = { widths: null, height: 900, wait: 300, mask: [], track: [], affected: [], revision: null, out: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2), value = rest[++i];
    if (value === undefined) throw new InputError(arg + " 後面缺少值");
    if (key === "widths") flags.widths = value.split(",").map((s) => Number(s.trim()));
    else if (key === "height" || key === "wait") flags[key] = Number(value);
    else if (key === "mask" || key === "track" || key === "affected") flags[key].push(value);
    else if (key === "revision" || key === "out") flags[key] = value;
    else throw new InputError("不認得的參數 " + arg + "\n" + USAGE);
  }
  return { command, positional, flags };
}

function collectBoxes(arg) {
  const { landmarks, tracks, max } = arg;
  const sx = window.scrollX, sy = window.scrollY;
  const boxes = [];
  const labelOf = (el) => el.id ? "#" + el.id
    : el.dataset && el.dataset.component ? '[data-component="' + el.dataset.component + '"]'
    : el.dataset && el.dataset.section ? '[data-section="' + el.dataset.section + '"]'
    : el.tagName.toLowerCase();
  const add = (el, selector) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    boxes.push({ label: labelOf(el), selector, left: Math.floor(r.left + sx), top: Math.floor(r.top + sy), right: Math.ceil(r.right + sx), bottom: Math.ceil(r.bottom + sy) });
  };
  for (const el of document.querySelectorAll(landmarks)) { if (boxes.length >= max) break; add(el, null); }
  for (const sel of tracks) for (const el of document.querySelectorAll(sel)) add(el, sel);
  const body = document.body || document.documentElement;
  return {
    boxes,
    scrollHeight: Math.max(document.documentElement.scrollHeight, body.scrollHeight),
    scrollWidth: Math.max(document.documentElement.scrollWidth, body.scrollWidth),
  };
}

async function settle(page, flags) {
  await page.evaluate(async (vh) => {
    await document.fonts.ready;
    const height = () => Math.max(document.documentElement.scrollHeight, (document.body || document.documentElement).scrollHeight);
    for (let y = 0; y < height(); y += vh) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  }, flags.height);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts.ready;
    const pending = [...document.images].filter((im) => !im.complete).map((im) => new Promise((r) => {
      im.addEventListener("load", r, { once: true }); im.addEventListener("error", r, { once: true });
    }));
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 10000))]);
  });
  if (flags.wait > 0) await page.waitForTimeout(flags.wait);
}

async function capture(target, outDir, flags) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new InputError("輸出目錄已有檔案，不覆蓋：" + outDir);
  const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : pathToFileURL(path.resolve(target)).href;
  const pw = findPlaywright(), exe = findHeadlessShell();
  if (!pw || !exe) {
    console.error("找不到 playwright 模組（" + pw + "）或 chrome-headless-shell（" + exe + "）；長頁比對無法執行，改請視覺查核子代理在受影響範圍外逐寬度目視確認。");
    return 2;
  }
  const { chromium } = require(pw);
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars"] });
  const manifest = { tool: "pixel-diff", schema: 1, url, revision: flags.revision, capturedAt: new Date().toISOString(), viewportHeight: flags.height, masks: flags.mask, tracked: flags.track, widths: [] };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const width of flags.widths) {
      const context = await browser.newContext({ viewport: { width, height: flags.height }, deviceScaleFactor: 1, locale: "zh-TW" });
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: 60000 });
        const invalid = await page.evaluate((sels) => sels.filter((s) => { try { document.querySelectorAll(s); return false; } catch (_) { return true; } }), [...flags.mask, ...flags.track]);
        if (invalid.length) throw new InputError("選擇器無效：" + invalid.join("、"));
        await settle(page, flags);
        const info = await page.evaluate(collectBoxes, { landmarks: LANDMARKS, tracks: flags.track, max: MAX_BOXES });
        const pageW = Math.max(width, info.scrollWidth), pageH = info.scrollHeight;
        const masks = flags.mask.map((s) => page.locator(s));
        const rgba = Buffer.alloc(pageW * pageH * 4);
        let offset = 0;
        for (let y = 0; y < pageH; y += CHUNK) {
          const h = Math.min(CHUNK, pageH - y);
          const shot = await page.screenshot({ fullPage: true, clip: { x: 0, y, width: pageW, height: h }, animations: "disabled", caret: "hide", scale: "css", mask: masks });
          const img = decodePng(shot);
          if (img.width !== pageW || img.height !== h) throw new Error("分段截圖尺寸 " + img.width + "x" + img.height + " 與預期 " + pageW + "x" + h + " 不符");
          img.data.copy(rgba, offset); offset += img.data.length;
        }
        const png = encodePng(pageW, pageH, rgba);
        const file = "w" + width + ".png";
        fs.writeFileSync(path.join(outDir, file), png, { flag: "wx" });
        manifest.widths.push({ width, file, sha256: sha256(png), pixelWidth: pageW, pixelHeight: pageH, scrollWidth: info.scrollWidth, overflowX: info.scrollWidth > width, boxes: info.boxes });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ outDir, revision: flags.revision, widths: manifest.widths.map((w) => ({ width: w.width, file: w.file, size: [w.pixelWidth, w.pixelHeight], overflowX: w.overflowX })) }));
  return 0;
}

function readManifest(dir) {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) throw new InputError("找不到 " + file + "；這個目錄要先用 capture 產生");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (m.tool !== "pixel-diff" || !Array.isArray(m.widths)) throw new InputError(file + " 不是 pixel-diff 的截圖紀錄");
  return m;
}
function readChecked(dir, entry) {
  const buf = fs.readFileSync(path.join(dir, entry.file));
  if (sha256(buf) !== entry.sha256) throw new InputError(path.join(dir, entry.file) + " 與 manifest 的雜湊不符（截圖被改過）");
  return buf;
}
const matches = (box, spec) => box.selector === spec || box.label === spec;
const u32 = (img) => new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length / 4);
const rowBoxes = (boxes, y) => boxes.filter((b) => b.top <= y && y < b.bottom);
function inBoxes(list, x) { for (const b of list) if (b.left <= x && x < b.right) return true; return false; }
function rectCovered(rect, boxes) {
  for (let y = rect.top; y < rect.bottom; y++) {
    const spans = rowBoxes(boxes, y).map((b) => [b.left, b.right]).sort((p, q) => p[0] - q[0]);
    let x = rect.left;
    for (const [l, r] of spans) { if (l > x) break; if (r > x) x = r; if (x >= rect.right) break; }
    if (x < rect.right) return false;
  }
  return true;
}
function sectionsFor(rect, boxes) {
  const hits = boxes.filter((b) => b.left < rect.right && rect.left < b.right && b.top < rect.bottom && rect.top < b.bottom)
    .map((b) => ({ label: b.label, area: (b.right - b.left) * (b.bottom - b.top) }))
    .sort((p, q) => p.area - q.area);
  const out = [];
  for (const h of hits) { if (!out.includes(h.label)) out.push(h.label); if (out.length >= 8) break; }
  return out;
}

// 頁高相同：逐像素比，差異像素逐一判定是否落在受影響範圍內。
function diffSameSize(a, b, affected) {
  const W = a.width, H = a.height, pa = u32(a), pb = u32(b), rowBytes = W * 4;
  const flags = new Uint8Array(W * H);
  const bands = [];
  for (let y = 0; y < H; y++) {
    if (a.data.compare(b.data, y * rowBytes, (y + 1) * rowBytes, y * rowBytes, (y + 1) * rowBytes) === 0) continue;
    const list = rowBoxes(affected, y);
    let minX = W, maxX = -1, count = 0, outside = 0;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      if (pa[i] === pb[i]) continue;
      count++; if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (inBoxes(list, x)) flags[i] = 1; else { flags[i] = 2; outside++; }
    }
    const last = bands[bands.length - 1];
    if (last && y - last.bottom <= 16) {
      last.bottom = y + 1; last.left = Math.min(last.left, minX); last.right = Math.max(last.right, maxX + 1);
      last.differingPixels += count; last.outsidePixels += outside;
    } else bands.push({ top: y, bottom: y + 1, left: minX, right: maxX + 1, differingPixels: count, outsidePixels: outside });
  }
  for (const band of bands) band.inside = band.outsidePixels === 0;
  return { bands, flags };
}

// 頁高不同：上方逐列對齊、下方從底部逐列對齊，中間那一段就是變動段。
// 變動段的左右範圍取「上對齊或下對齊任一不同」的欄，比只算兩種都不同的欄更寬、判定更保守；
// 整段（含左右範圍）必須落在受影響範圍內才算 inside。兩種對齊都不同的像素在差異圖標色。
function diffShifted(a, b, affectedNew, affectedOld) {
  const W = a.width, rowBytes = W * 4, minH = Math.min(a.height, b.height), shift = b.height - a.height;
  const rowEq = (ya, yb) => a.data.compare(b.data, yb * rowBytes, (yb + 1) * rowBytes, ya * rowBytes, (ya + 1) * rowBytes) === 0;
  let top = 0;
  while (top < minH && rowEq(top, top)) top++;
  let tail = 0;
  while (tail < minH - top && rowEq(a.height - 1 - tail, b.height - 1 - tail)) tail++;
  const newEnd = b.height - tail, oldEnd = a.height - tail;
  const pa = u32(a), pb = u32(b);
  const flags = new Uint8Array(W * b.height);
  let minX = W, maxX = -1, count = 0;
  const scan = (src, other, otherH, from, to, delta, mark) => {
    for (let y = from; y < to; y++) {
      for (let x = 0, i = y * W; x < W; x++, i++) {
        const p = src[i];
        const sameTop = y < otherH && other[y * W + x] === p;
        const yo = y + delta;
        const sameShift = yo >= 0 && yo < otherH && other[yo * W + x] === p;
        if (sameTop && sameShift) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (sameTop || sameShift) continue;
        count++;
        if (mark) flags[i] = 2;
      }
    }
  };
  scan(pb, pa, a.height, top, newEnd, -shift, true);
  scan(pa, pb, b.height, top, oldEnd, shift, false);
  if (maxX < 0) { minX = 0; maxX = W - 1; }
  const newRect = { left: minX, right: maxX + 1, top, bottom: newEnd };
  const oldRect = { left: minX, right: maxX + 1, top, bottom: oldEnd };
  const okNew = newRect.bottom <= newRect.top || rectCovered(newRect, affectedNew);
  const okOld = oldRect.bottom <= oldRect.top || rectCovered(oldRect, affectedOld.length ? affectedOld : affectedNew);
  const inside = okNew && okOld;
  if (inside) for (let i = 0; i < flags.length; i++) if (flags[i] === 2) flags[i] = 1;
  return {
    bands: [{ top, bottom: newEnd, left: minX, right: maxX + 1, oldTop: top, oldBottom: oldEnd, shift, differingPixels: count, inside }],
    flags,
    oldRect,
  };
}

function diffImage(b, flags) {
  const out = Buffer.alloc(b.data.length);
  for (let i = 0, p = 0; i < flags.length; i++, p += 4) {
    if (flags[i] === 2) { out[p] = 230; out[p + 1] = 0; out[p + 2] = 60; }
    else if (flags[i] === 1) { out[p] = 255; out[p + 1] = 150; out[p + 2] = 0; }
    else { const v = Math.round(170 + (b.data[p] * 0.3 + b.data[p + 1] * 0.59 + b.data[p + 2] * 0.11) * 0.33); out[p] = v; out[p + 1] = v; out[p + 2] = v; }
    out[p + 3] = 255;
  }
  return encodePng(b.width, b.height, out);
}

function compare(oldDir, newDir, flags) {
  const oldM = readManifest(oldDir), newM = readManifest(newDir);
  const all = [...oldM.widths, ...newM.widths];
  const unknown = flags.affected.filter((spec) => !all.some((w) => (w.boxes || []).some((b) => matches(b, spec))));
  if (unknown.length) {
    throw new InputError("受影響範圍在截圖紀錄裡找不到：" + unknown.join("、") + "。capture 時用 --track 記下它們的位置，或改用紀錄裡的標籤（#id、[data-component=\"…\"]、header、footer 等）");
  }
  const outDir = path.resolve(flags.out || newDir);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "") + "-" + process.pid;
  const base = "pixel-diff-" + stamp;
  const widths = [...new Set(all.map((w) => w.width))].sort((x, y) => x - y);
  const results = [];
  for (const width of widths) {
    const ow = oldM.widths.find((w) => w.width === width), nw = newM.widths.find((w) => w.width === width);
    if (!ow || !nw) { results.push({ width, verdict: "missing", label: VERDICT_LABEL.missing, missingIn: ow ? "本版" : "前一版" }); continue; }
    const oldBuf = readChecked(oldDir, ow), newBuf = readChecked(newDir, nw);
    const r = { width, oldSha256: ow.sha256, newSha256: nw.sha256 };
    if (ow.sha256 === nw.sha256) { r.verdict = "identical"; r.label = VERDICT_LABEL.identical; results.push(r); continue; }
    const a = decodePng(oldBuf), b = decodePng(newBuf);
    r.oldSize = [a.width, a.height]; r.newSize = [b.width, b.height];
    const affNew = flags.affected.flatMap((s) => nw.boxes.filter((x) => matches(x, s)));
    const affOld = flags.affected.flatMap((s) => (ow.boxes || []).filter((x) => matches(x, s)));
    const notHere = flags.affected.filter((s) => !nw.boxes.some((x) => matches(x, s)));
    if (notHere.length) r.affectedNotFound = notHere;
    let res;
    if (a.width !== b.width) {
      r.widthChanged = true;
      res = { bands: [{ top: 0, bottom: b.height, left: 0, right: b.width, inside: false, note: "頁寬不同（可能有橫向溢出），整頁要重驗" }], flags: null };
    } else if (a.height === b.height) {
      res = diffSameSize(a, b, [...affNew, ...affOld]);
    } else {
      r.heightChanged = true;
      res = diffShifted(a, b, affNew, affOld);
    }
    for (const band of res.bands) {
      band.sections = band.bottom > band.top ? sectionsFor(band, nw.boxes) : sectionsFor(res.oldRect || band, ow.boxes || []);
    }
    r.bands = res.bands;
    r.verdict = !res.bands.length ? "identical" : res.bands.every((band) => band.inside) ? "inside" : "outside";
    r.label = VERDICT_LABEL[r.verdict];
    if (res.flags && res.bands.length) {
      const file = path.join(outDir, base + "-w" + width + ".png");
      fs.writeFileSync(file, diffImage(b, res.flags), { flag: "wx" });
      r.diffImage = file;
    }
    results.push(r);
  }
  const verdict = results.some((r) => r.verdict === "outside" || r.verdict === "missing") ? "outside"
    : results.some((r) => r.verdict === "inside") ? "inside" : "identical";
  const needsReverify = results.filter((r) => r.verdict === "outside" || r.verdict === "missing").map((r) => ({
    width: r.width,
    wholePage: r.verdict === "missing" || !!r.widthChanged,
    bands: (r.bands || []).filter((b) => !b.inside).map((b) => ({ top: b.top, bottom: b.bottom, left: b.left, right: b.right, sections: b.sections })),
  }));
  const side = (m, dir) => ({ dir, url: m.url, revision: m.revision, capturedAt: m.capturedAt, masks: m.masks });
  const report = { tool: "pixel-diff", schema: 1, comparedAt: new Date().toISOString(), old: side(oldM, oldDir), new: side(newM, newDir), affected: flags.affected, verdict, label: OVERALL_LABEL[verdict], results, needsReverify };
  const reportPath = path.join(outDir, base + ".json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ verdict, label: OVERALL_LABEL[verdict], report: reportPath, widths: results.map((r) => ({ width: r.width, verdict: r.verdict, bands: (r.bands || []).length })) }));
  return verdict === "outside" ? 1 : 0;
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (command === "capture") {
    if (positional.length !== 2) throw new InputError(USAGE);
    if (!flags.widths || !flags.widths.length || flags.widths.some((w) => !Number.isInteger(w) || w < 100 || w > 4000)) {
      throw new InputError("--widths 要給 100～4000 的整數，以逗號分隔，例如 --widths 320,768,1440");
    }
    if (!Number.isInteger(flags.height) || flags.height < 100) throw new InputError("--height 要給 100 以上的整數");
    if (!Number.isFinite(flags.wait) || flags.wait < 0) throw new InputError("--wait 要給 0 以上的毫秒數");
    return capture(positional[0], path.resolve(positional[1]), flags);
  }
  if (command === "compare") {
    if (positional.length !== 2) throw new InputError(USAGE);
    return compare(path.resolve(positional[0]), path.resolve(positional[1]), flags);
  }
  throw new InputError(USAGE);
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  if (e instanceof InputError) { console.error(e.message); process.exit(3); }
  console.error("pixel-diff 失敗：" + (e && e.stack ? e.stack : e));
  process.exit(4);
});

