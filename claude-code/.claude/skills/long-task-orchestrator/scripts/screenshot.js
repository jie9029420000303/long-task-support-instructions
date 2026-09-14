#!/usr/bin/env node
// 無頭截圖落檔工具：把畫面存成 PNG，讓主線能 Read 檢視證據。
// 用法：node screenshot.js <url> <out.png> [--size WxH] [--click <css選擇器>[:次數]] [--full]
// 依賴：本機 npx 快取裡的 playwright 模組 + ms-playwright 的 chrome-headless-shell（不需 npx playwright install）。
const fs = require("fs");
const path = require("path");
const os = require("os");

function findPlaywright() {
  const roots = [path.join(os.homedir(), ".npm", "_npx")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, "node_modules", "playwright");
      if (fs.existsSync(p)) return p;
    }
  }
  try { return require.resolve("playwright"); } catch (_) { return null; }
}
function findHeadlessShell() {
  const base = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const d of dirs) {
    for (const sub of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac", "chrome-headless-shell-linux"]) {
      const exe = path.join(base, d, sub, "chrome-headless-shell");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.error("用法：node screenshot.js <url> <out.png> [--size WxH] [--click <selector>[:n]] [--full]"); process.exit(1); }
  const [url, out] = args;
  let width = 1280, height = 800, click = null, clickTimes = 1, full = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--size") { const [w, h] = args[++i].split("x").map(Number); width = w; height = h; }
    else if (args[i] === "--click") { const v = args[++i]; const m = v.match(/^(.*?)(?::(\d+))?$/); click = m[1]; clickTimes = Number(m[2] || 1); }
    else if (args[i] === "--full") full = true;
  }
  const pw = findPlaywright(); const exe = findHeadlessShell();
  if (!pw || !exe) { console.error(`找不到 playwright 模組（${pw}）或 chrome-headless-shell（${exe}）；改用 Browser pane 截圖並明說證據只在對話中。`); process.exit(2); }
  const { chromium } = require(pw);
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width, height }, locale: "zh-TW" });
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  if (click) { for (let i = 0; i < clickTimes; i++) await page.click(click); await page.waitForTimeout(150); }
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await page.screenshot({ path: out, fullPage: full });
  await browser.close();
  console.log(JSON.stringify({ out: path.resolve(out), viewport: `${width}x${height}`, scrollWidth, clicked: click ? `${click} x${clickTimes}` : null }));
})().catch((e) => { console.error("screenshot failed:", e.message); process.exit(3); });
