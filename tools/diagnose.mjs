// Waarom is een winkel lastig? Probeert homepage + een productpagina met fetch, browser-TLS en (optioneel) Chromium,
// en rapporteert status, beveiliging (Cloudflare/Akamai/DataDome/…) en welke productdata er in de HTML zit.
//   node tools/diagnose.mjs <out> '<json: [{"id":"x","product":"https://…"}]>'   (BROWSER=1 voor Chromium erbij)
import fs from "node:fs";
import { get, setEngine, closeBrowser } from "../src/http.mjs";

const out = process.argv[2];
const jobs = JSON.parse(process.argv[3]);
const shops = JSON.parse(fs.readFileSync("config/shops.json", "utf8"));
fs.mkdirSync(out, { recursive: true });

function protection(h = {}, body = "") {
  const k = Object.keys(h).join(" ").toLowerCase(), v = JSON.stringify(h).toLowerCase(), b = body.slice(0, 30000).toLowerCase();
  const p = [];
  if (k.includes("cf-ray") || v.includes("cloudflare")) p.push("cloudflare");
  if (b.includes("challenge-platform") || b.includes("cf-chl")) p.push("cf-challenge");
  if (k.includes("x-datadome") || b.includes("datadome")) p.push("datadome");
  if (v.includes("akamai") || b.includes("/akam/")) p.push("akamai");
  if (b.includes("_incapsula_") || v.includes("incap")) p.push("incapsula");
  if (b.includes("px-captcha") || b.includes("perimeterx")) p.push("perimeterx");
  if (k.includes("x-kpsdk")) p.push("kasada");
  return [...new Set(p)].join(",") || "-";
}
function content(html = "") {
  const f = [];
  if (/application\/ld\+json/.test(html)) f.push("ld" + (/"@type"\s*:\s*"Product"/.test(html) ? "+Product" : ""));
  if (html.includes("__NEXT_DATA__")) f.push("next");
  if (html.includes("self.__next_f")) f.push("next-rsc");
  if (/__NUXT__|__NUXT_DATA__/.test(html)) f.push("nuxt");
  if (html.includes("__PRELOADED_STATE__") || html.includes("__INITIAL_STATE__")) f.push("state");
  if (/itemprop=["']price/.test(html)) f.push("microdata");
  if (/property=["'](product|og):price/.test(html)) f.push("ogprice");
  const t = (html.match(/<title[^>]*>([^<]{0,60})/i) || [])[1];
  return `${f.join("+") || "-"} | ${html.length}B | ${t ? t.trim() : ""}`;
}

const lines = [];
for (const j of jobs) {
  const s = shops.find((x) => x.id === j.id);
  const urls = [`https://${s.domain}/`, j.product].filter(Boolean);
  const engines = [["fetch"], ["impersonate", "chrome"], ["impersonate", "safari"]];
  if (process.env.BROWSER) engines.push(["browser"]);
  for (const [eng, imp] of engines) {
    setEngine(eng, imp, 8765, eng === "browser" ? `https://${s.domain}` : null);
    for (const u of urls) {
      const tag = `${j.id}\t${eng}${imp ? ":" + imp : ""}\t${u === urls[0] ? "home" : "prod"}`;
      let r;
      try { r = await get(u, { retries: 0, timeout: 40000, okStatuses: [200, 201, 202, 301, 302, 400, 401, 403, 404, 429, 500, 503] }); }
      catch (e) { lines.push(`${tag}\tERR ${String(e.message).slice(0, 80)}`); continue; }
      const h = Object.fromEntries(r.headers || []);
      lines.push(`${tag}\t${r.status}\t${protection(h, r.text)}\t${content(r.text)}`);
      if (u !== urls[0]) fs.writeFileSync(`${out}/${j.id}-${eng}${imp || ""}.html`, r.text.slice(0, 1500000));
    }
    if (eng === "browser") await closeBrowser();
  }
}
fs.writeFileSync(`${out}/_index.txt`, lines.join("\n") + "\n");
console.log(lines.join("\n"));
