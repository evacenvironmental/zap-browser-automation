// file: server.js
/**
 * Endpoints:
 *  GET  /health
 *  GET  /info?url=...
 *  POST /run { url, buttonId?, selector?, frameUrlContains?, waitMs?, waitForSelectorMs?, extraWaitAfterLoadMs?, useJsClick? }
 */
import express from "express";
import puppeteer from "puppeteer";
import pRetry from "p-retry";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Tunables
const HEADLESS = process.env.HEADLESS !== "false";
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 45000);
const CLICK_TIMEOUT_MS_DEFAULT = Number(process.env.CLICK_TIMEOUT_MS || 20000);
const DEFAULT_WAIT_MS = Number(process.env.DEFAULT_WAIT_MS || 60000);

// Escape CSS id (Node lacks CSS.escape)
const escapeCssId = (id) =>
  String(id).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");

// Resolve a working browser path: env → Puppeteer's downloaded → system paths
const resolveExecutable = () => {
  const tried = [];
  const tryPath = (p) => {
    if (!p) return null;
    tried.push(p);
    try { if (fs.existsSync(p)) return p; } catch {}
    return null;
  };

  // 1) Env (set by Puppeteer Docker image)
  const envPath = tryPath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (envPath) return envPath;

  // 2) Puppeteer’s own downloaded browser (if present)
  try {
    const p = puppeteer.executablePath();
    const pp = tryPath(p);
    if (pp) return pp;
  } catch {}

  // 3) Common system locations
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ];
  for (const c of candidates) {
    const found = tryPath(c);
    if (found) return found;
  }

  throw new Error(`No browser executable found. Checked: ${tried.join(", ")}`);
};

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      executablePath: resolveExecutable(),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );
    const resp = await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: NAV_TIMEOUT_MS });
    const title = await page.title().catch(() => null);
    return res.json({ ok: true, finalUrl: page.url(), httpStatus: resp?.status?.() ?? null, title });
  } catch (err) {
    console.error("Error in /info:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

app.post("/run", async (req, res) => {
  const {
    url,
    buttonId,
    selector,
    frameUrlContains,
    waitMs,
    waitForSelectorMs,
    extraWaitAfterLoadMs,
    useJsClick
  } = req.body || {};

  if (!url) return res.status(400).json({ success: false, error: "Missing url" });
  if (!buttonId && !selector) return res.status(400).json({ success: false, error: "Provide buttonId or selector" });

  let browser;
  const startedAt = Date.now();

  try {
    const execPath = resolveExecutable();
    console.log("Using browser executable:", execPath);

    browser = await puppeteer.launch({
      headless: HEADLESS,
      executablePath: execPath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );

    let navResp;
    await pRetry(async () => {
      navResp = await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: NAV_TIMEOUT_MS });
    }, { retries: 2 });

    const navStatus = navResp?.status?.() ?? null;
    const afterNavUrl = page.url();

    if (Number(extraWaitAfterLoadMs) > 0) {
      await page.waitForTimeout(Number(extraWaitAfterLoadMs));
    }

    // Choose context (iframe support)
    let ctx = page;
    if (frameUrlContains) {
      const frames = page.frames();
      const match = frames.find(f => (f.url() || "").includes(frameUrlContains));
      if (!match) {
        const frameUrls = frames.map(f => f.url()).filter(Boolean);
        console.error("Iframe not found", { frameUrlContains, frameUrls });
        return res.status(408).json({
          success: false,
          error: `Iframe not found for frameUrlContains="${frameUrlContains}"`,
          details: { afterNavUrl, navStatus, frameUrls }
        });
      }
      ctx = match;
    }

    const css = selector ? String(selector) : `#${escapeCssId(buttonId)}`;
    const selectorTimeout = Number.isFinite(Number(waitForSelectorMs)) ? Number(waitForSelectorMs) : CLICK_TIMEOUT_MS_DEFAULT;

    try {
      await ctx.waitForSelector(css, { timeout: selectorTimeout, visible: true });
    } catch (e) {
      const pageTitle = await page.title().catch(() => null);
      const finalUrl = page.url();
      console.error("Timeout waiting for selector", { css, selectorTimeout, finalUrl, pageTitle });
      return res.status(408).json({
        success: false,
        error: `Timeout waiting for selector "${css}"`,
        details: { afterNavUrl, finalUrl, navStatus, pageTitle }
      });
    }

    await ctx.evaluate((sel) => { document.querySelector(sel)?.scrollIntoView({ block: "center", inline: "center" }); }, css);

    if (useJsClick) {
      const clicked = await ctx.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, css);
      if (!clicked) return res.status(500).json({ success: false, error: `Failed to JS-click ${css}` });
    } else {
      await ctx.click(css, { delay: 25 });
    }

    const sleepMs = Number.isFinite(Number(waitMs)) ? Number(waitMs) : DEFAULT_WAIT_MS;
    await ctx.waitForTimeout(sleepMs);

    const elapsedMs = Date.now() - startedAt;
    return res.json({ success: true, details: { url, finalUrl: page.url(), httpStatus: navStatus, usedSelector: css, usedFrameFilter: frameUrlContains || null, waitedMs: sleepMs, elapsedMs } });
  } catch (err) {
    console.error("Error in /run:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Service listening on :${port}`));
