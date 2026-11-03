// Maakt automatisch configs voor winkels waarvan discovery 'ok' gaf.
//   node tools/autoconfig.mjs <dir met discover/*.json> [engine]
import fs from "node:fs";
const dir = process.argv[2];
const engine = process.argv[3] || "impersonate";
let made = 0;
for (const f of fs.readdirSync(`${dir}/discover`)) {
  const r = JSON.parse(fs.readFileSync(`${dir}/discover/${f}`, "utf8"));
  if (!/^(ok|partial):/.test(r.verdict || "")) continue;
  const out = `config/shops/${r.id}.json`;
  if (fs.existsSync(out)) continue;
  const s = r.suggestedConfig || {};
  const cfg = { strategy: "sitemap", ...(engine === "impersonate" ? { engine: "impersonate", impersonate: "chrome" } : {}), sitemaps: s.sitemaps, concurrency: 3, delayMs: 300, auto: true };
  if (s.sitemapInclude) cfg.sitemapInclude = s.sitemapInclude;
  if (s.urlInclude) cfg.urlInclude = s.urlInclude;
  // meertalige sites: alleen NL
  const nl = (r.samples || []).map((x) => x.url).find((u) => /\/nl[-_]nl\/|\/nl\//i.test(u));
  if (!cfg.urlInclude && nl) cfg.urlInclude = /\/nl[-_]nl\//i.test(nl) ? "/nl[-_]nl/" : "/nl/";
  fs.writeFileSync(out, JSON.stringify(cfg, null, 1) + "\n");
  made++;
  console.log(r.id, r.verdict, JSON.stringify(cfg).slice(0, 200));
}
console.log("gemaakt:", made);
