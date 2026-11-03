// Toont de sitemap-structuur van winkels: per sitemap het aantal URL's en voorbeelden.
//   ENGINE=chrome node tools/smtree.mjs out-dir shopId [shopId...]
import fs from "node:fs";
import { get, setEngine } from "../src/http.mjs";
import { robotsSitemaps, parseSitemap } from "../src/sitemap.mjs";
if (process.env.ENGINE === "browser") setEngine("browser"); else if (process.env.ENGINE) setEngine("impersonate", process.env.ENGINE);
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const shops = JSON.parse(fs.readFileSync("config/shops.json", "utf8"));
const lines = [];
for (const id of process.argv.slice(3)) {
  const s = shops.find((x) => x.id === id); const origin = `https://${s.domain}`;
  const cfgP = `config/shops/${id}.json`; const cfg = fs.existsSync(cfgP) ? JSON.parse(fs.readFileSync(cfgP)) : {};
  let roots = cfg.sitemaps || (await robotsSitemaps(origin)).sitemaps;
  if (!roots.length) roots = [`${origin}/sitemap.xml`];
  lines.push(`=== ${id} roots: ${roots.slice(0, 5).join(" ")}`);
  const queue = roots.map((r) => [r, 0]); const seen = new Set(); let n = 0;
  while (queue.length && n < 40) {
    const [sm, d] = queue.shift(); if (seen.has(sm)) continue; seen.add(sm); n++;
    try {
      const { isIndex, entries } = parseSitemap((await get(sm, { timeout: 60000 })).text);
      for (const e of entries) { try { e.loc = new URL(e.loc, sm).href; } catch {} }
      if (isIndex) { lines.push(`${"  ".repeat(d)}[index] ${sm} (${entries.length})`); entries.slice(0, 60).forEach((e) => queue.push([e.loc, d + 1])); }
      else lines.push(`${"  ".repeat(d)}${sm} (${entries.length}) ${entries.filter((_, i) => i % Math.max(1, Math.floor(entries.length / 3)) === 0).slice(0, 3).map((e) => e.loc).join(" ")}`);
    } catch (e) { lines.push(`${"  ".repeat(d)}FAIL ${sm} ${e.message}`); }
  }
}
fs.writeFileSync(`${out}/_index.txt`, lines.join("\n") + "\n");
console.log(lines.join("\n"));
