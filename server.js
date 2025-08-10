import express from "express";
import puppeteer from "puppeteer";
import pRetry from "p-retry";

const app = express();
app.use(express.json({ limit: "256kb" }));

const HEADLESS = process.env.HEADLESS !== "false";
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 30000);
const CLICK_TIMEOUT_MS = Number(process.env.CLICK_TIMEOUT_MS || 15000);
const DEFAULT_WAIT_MS = Number(process.env.DEFAULT_WAIT_MS || 60000);

const escapeCssId = (id) =>
  String(id).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/run", async (req, res) => {
  const { url, buttonId, waitMs } = req.body || {};
  if (!url || !buttonId) {
    return res.status(400).json({ success: false, error: "Missing url or buttonId" });
  }

  let browser;
  const startedAt = Date.now();

  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
    );

    await pRetry(
      () =>
        page.goto(url, {
          waitUntil: ["domcontentloaded", "networkidle2"],
          timeout: NAV_TIMEOUT_MS
        }),
      { retries: 2 }
    );

    const selector = `#${escapeCssId(buttonId)}`;
    await page.waitForSelector(selector, { timeout: CLICK_TIMEOUT_MS, visible: true });

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el?.scrollIntoView({ block: "center", inline: "center" });
    }, selector);

    await page.click(selector, { delay: 25 });

    const sleepMs = Number.isFinite(Number(waitMs)) ? Number(waitMs) : DEFAULT_WAIT_MS;
    await page.waitForTimeout(sleepMs);

    const elapsedMs = Date.now() - startedAt;
    return res.json({
      success: true,
      details: { url, buttonId, waitedMs: sleepMs, elapsedMs }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Service listening on :${port}`));
