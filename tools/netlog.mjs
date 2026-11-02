// Opent pagina's in echte Chromium en logt alle XHR/fetch-verzoeken (API's ontdekken, bv. voorraad per filiaal).
//   node tools/netlog.mjs out-dir '<json: [{"url": "...", "actions": [{"click": "selector"}, {"wait": 2000}, {"fill": ["sel","tekst"]}]}]>'
import fs from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2] || "probe-out";
const jobs = JSON.parse(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: !process.env.HEADFUL, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ locale: "nl-NL", timezoneId: "Europe/Amsterdam", viewport: { width: 1366, height: 900 },
  geolocation: { latitude: 52.0705, longitude: 4.3007 }, permissions: ["geolocation"] });
await ctx.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
const log = [];
ctx.on("response", async (res) => {
  const req = res.request();
  const type = req.resourceType();
  if (!["xhr", "fetch", "document"].includes(type)) return;
  let body = "";
  try { body = (await res.text()).slice(0, 3000); } catch {}
  log.push({ type, method: req.method(), url: req.url(), status: res.status(), post: req.postData()?.slice(0, 1500) || null, reqHeaders: type !== "document" ? await req.allHeaders().catch(() => ({})) : undefined, body: type === "document" ? body.slice(0, 300) : body });
});
let n = 0;
for (const job of jobs) {
  const page = await ctx.newPage();
  try {
    await page.goto(job.url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Alles accepteren')", "button:has-text('Accepteren')", "button:has-text('Akkoord')", "button:has-text('Alle cookies accepteren')"]) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 800 })) { await b.click(); break; } } catch {}
    }
    for (const a of job.actions || []) {
      try {
        if (a.click) await page.locator(a.click).first().click({ timeout: 8000 });
        if (a.fill) await page.locator(a.fill[0]).first().fill(a.fill[1], { timeout: 8000 });
        if (a.press) await page.keyboard.press(a.press);
        if (a.wait) await page.waitForTimeout(a.wait);
        if (a.scroll) await page.mouse.wheel(0, a.scroll);
      } catch (e) { log.push({ action: a, error: String(e).slice(0, 200) }); }
    }
    await page.waitForTimeout(job.waitAfter || 4000);
    fs.writeFileSync(`${out}/page${n}.html`, (await page.content()).slice(0, 400000));
    await page.screenshot({ path: `${out}/page${n}.png` }).catch(() => {});
  } catch (e) { log.push({ url: job.url, error: String(e) }); }
  n++;
  await page.close();
}
await browser.close();
fs.writeFileSync(`${out}/netlog.json`, JSON.stringify(log, null, 1));
const lines = log.filter((l) => l.url).map((l) => `${l.status} ${l.method} ${l.type} ${l.url.slice(0, 220)}`);
fs.writeFileSync(`${out}/_index.txt`, lines.join("\n") + "\n");
console.log(lines.length, "requests");
