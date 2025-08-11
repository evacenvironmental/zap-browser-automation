// file: server.js
/**
 * Endpoints:
 *   GET  /health -> { ok: true }
 *   GET  /info?url=... -> quick fetch to see title/finalUrl/status
 *   POST /run
 *     Body:
 *       url: string (required)
 *       buttonId?: string            // click by id
 *       selector?: string            // or click by CSS selector (alternative to buttonId)
 *       frameUrlContains?: string    // if button lives inside an iframe whose src includes this
 *       waitMs?: number              // wait after click (default 60000)
 *       waitForSelectorMs?: number   // timeout waiting for button (default 20000)
 *       extraWaitAfterLoadMs?: number// extra wait after navigation (default 0)
 *       useJsClick?: boolean         // fallback to el.click() (true helps when overlays block clicks)
 *
 * Response:
 *   { success, details? , error?, hint? }
 */
import express from "express";
import puppeteer from "puppeteer";
import pRetry from "p-retry";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Tunables
const HEADLESS = process.env.HEADLESS !== "false";
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 45000);
const CLICK_TIMEOUT_MS_DEFAULT = Number(process.env.CLICK_TIMEOUT_MS || 20000);
const DEFAULT_WAIT_MS = Number(process.env.DEFAULT_WAIT_MS || 60000);

const escapeCssId = (id) =>
  String(id).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );
    const resp = await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: NAV_TIMEOUT_MS });
    const title = await page.title().catch(() => null);
    return res.json({
      ok: true,
      finalUrl: page.url(),
      httpStatus: resp?.status?.() ?? null,
      title
    });
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
  if (!buttonId && !selector) {
    return res.status(400).json({ success: false, error: "Provide buttonId or selector" });
  }

  let browser;
  const startedAt = Date.now();

  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();

    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );

    let navResp;
    await pRetry(
      async () => {
        navResp = await page.goto(url, {
          waitUntil: ["domcontentloaded", "networkidle2"],
          timeout: NAV_TIMEOUT_MS
        });
      },
      { retries: 2 }
    );
    const navStatus = navResp?.status?.() ?? null;
    const afterNavUrl = page.url();

    if (Number(extraWaitAfterLoadMs) > 0) {
      await page.waitForTimeout(Number(extraWaitAfterLoadMs));
    }

    // Choose context (page or iframe)
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
          hint: "Open DevTools, check iframe src, pass a unique substring from its URL.",
          details: { afterNavUrl, navStatus, frameUrls }
        });
      }
      ctx = match;
    }

    // Build final selector
    const css = selector ? String(selector) : `#${escapeCssId(buttonId)}`;
    const selectorTimeout = Number.isFinite(Number(waitForSelectorMs)) ? Number(waitForSelectorMs) : CLICK_TIMEOUT_MS_DEFAULT;

    // Wait for element
    try {
      await ctx.waitForSelector(css, { timeout: selectorTimeout, visible: true });
    } catch (e) {
      const pageTitle = await page.title().catch(() => null);
      const finalUrl = page.url();
      console.error("Timeout waiting for selector", { css, selectorTimeout, finalUrl, pageTitle });
      return res.status(408).json({
        success: false,
        error: `Timeout waiting for selector "${css}"`,
        hint: frameUrlContains
          ? "Double-check frameUrlContains or increase waitForSelectorMs."
          : "If element is in an iframe, pass frameUrlContains; if SPA, increase waitForSelectorMs or extraWaitAfterLoadMs.",
        details: { afterNavUrl, finalUrl, navStatus, pageTitle }
      });
    }

    // Scroll into view
    await ctx.evaluate((sel) => {
      const el = document.querySelector(sel);
      el?.scrollIntoView({ block: "center", inline: "center" });
    }, css);

    // Click
    if (useJsClick) {
      const clicked = await ctx.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
      }, css);
      if (!clicked) {
        console.error("JS click failed", { css });
        return res.status(500).json({ success: false, error: `Failed to JS-click ${css}` });
      }
    } else {
      await ctx.click(css, { delay: 25 });
    }

    const sleepMs = Number.isFinite(Number(waitMs)) ? Number(waitMs) : DEFAULT_WAIT_MS;
    await ctx.waitForTimeout(sleepMs);

    const elapsedMs = Date.now() - startedAt;
    return res.json({
      success: true,
      details: {
        url,
        finalUrl: page.url(),
        httpStatus: navStatus,
        usedSelector: css,
        usedFrameFilter: frameUrlContains || null,
        waitedMs: sleepMs,
        elapsedMs
      }
    });
  } catch (err) {
    console.error("Error in /run:", err);
    return res.status(500).json({
      success: false,
      error: String(err?.message || err),
      hint: "See Render logs for stack; if page is SPA/iframe/anti-bot, pass frameUrlContains/useJsClick or share details."
    });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Service listening on :${port}`));
