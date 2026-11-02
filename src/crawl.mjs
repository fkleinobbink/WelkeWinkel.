// Crawler voor één winkel.
//   node src/crawl.mjs <shopId> [--prev prev.ndjson.gz] [--out out/] [--minutes 330] [--max 1000]
// Leest config/shops.json + config/shops/<id>.json, schrijft out/<id>.ndjson.gz + out/<id>.report.json
// Incrementeel: URL's met dezelfde lastmod die recent zijn opgehaald worden hergebruikt;
// bij tijdgebrek worden de oudste eerst ververst en blijft de rest uit de vorige run staan.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { get, setHostDelay, blockSignal } from "./http.mjs";
import { walkSitemaps, robotsSitemaps } from "./sitemap.mjs";
import { extractProducts } from "./extract.mjs";

export function loadShop(id) {
  const base = JSON.parse(fs.readFileSync("config/shops.json", "utf8")).find((s) => s.id === id);
  if (!base) throw new Error(`onbekende winkel ${id}`);
  const p = `config/shops/${id}.json`;
  const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  return { ...base, ...cfg };
}

const rx = (v) => (v ? new RegExp(v, "i") : null);

export function readNdjsonGz(file) {
  if (!file || !fs.existsSync(file)) return [];
  const txt = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function pickProduct(list, pageUrl, multi) {
  if (!list.length) return [];
  if (multi) return list;
  const priced = list.filter((p) => p.price != null);
  const main = list.find((p) => p.product_url === pageUrl) || priced[0] || list[0];
  const prices = priced.map((p) => p.price);
  const out = { ...main };
  if (list.length > 1) {
    out.variants = list.length;
    if (main.group_name) out.name = main.group_name;
    if (prices.length) out.price = Math.min(...prices);
    out.availability = list.some((p) => /instock/i.test(p.availability || "")) ? "InStock" : main.availability;
    out.gtins = [...new Set(list.map((p) => p.gtin).filter(Boolean))].slice(0, 50);
  }
  out.product_url = pageUrl;
  delete out.group_name;
  return [out];
}

export async function crawlShop(shop, { prevFile, outDir = "out", minutes = 330, max = Infinity, log = console.log } = {}) {
  const t0 = Date.now();
  const deadline = t0 + minutes * 60000;
  const origin = `https://${shop.domain}`;
  const report = { id: shop.id, started: new Date().toISOString(), errors: {}, blocked: 0, fetched: 0, reused: 0, kept: 0, products: 0 };
  setHostDelay(new URL(origin).host, shop.delayMs ?? 200);

  // Adapter? (src/adapters/<id>.mjs) -> volledig eigen logica
  const adapterPath = path.resolve(`src/adapters/${shop.adapter || shop.id}.mjs`);
  if (shop.strategy === "adapter" || (shop.adapter && fs.existsSync(adapterPath))) {
    const mod = await import(adapterPath);
    const items = [];
    for await (const p of mod.products({ shop, log, deadline, max, get, report })) {
      items.push({ ...p, fetched_at: new Date().toISOString() });
      if (items.length >= max) break;
    }
    return finish(shop, items, report, outDir, t0);
  }

  // 1) URL's verzamelen uit sitemaps
  let roots = shop.sitemaps;
  if (!roots || !roots.length) {
    const r = await robotsSitemaps(origin);
    roots = r.sitemaps.length ? r.sitemaps : [`${origin}/sitemap.xml`];
  }
  const smInc = rx(shop.sitemapInclude), smExc = rx(shop.sitemapExclude);
  const urlInc = rx(shop.urlInclude), urlExc = rx(shop.urlExclude);
  const { urls, opened } = await walkSitemaps(roots, {
    sitemapFilter: (u) => (!smInc || smInc.test(u)) && (!smExc || !smExc.test(u)),
    urlFilter: (u) => (!urlInc || urlInc.test(u)) && (!urlExc || !urlExc.test(u)),
    log,
  });
  const seen = new Set();
  let targets = urls.filter((u) => (seen.has(u.loc) ? false : seen.add(u.loc)));
  report.sitemapsOpened = opened;
  report.urls = targets.length;
  log(`${shop.id}: ${targets.length} product-URL's uit ${opened} sitemaps`);
  if (targets.length > max) targets = targets.slice(0, max);

  // 2) Vorige run inladen
  const prev = new Map();
  for (const p of readNdjsonGz(prevFile)) {
    const k = p.page_url || p.product_url;
    if (!prev.has(k)) prev.set(k, []);
    prev.get(k).push(p);
  }
  const reuseDays = shop.reuseDays ?? 7;
  const results = new Map();
  const todo = [];
  for (const t of targets) {
    const old = prev.get(t.loc);
    const age = old ? (Date.now() - Date.parse(old[0].fetched_at || 0)) / 86400000 : Infinity;
    if (old && t.lastmod && old[0].lastmod === t.lastmod && age < reuseDays) {
      results.set(t.loc, old);
      report.reused++;
    } else todo.push({ ...t, age });
  }
  todo.sort((a, b) => b.age - a.age); // nooit opgehaald / oudste eerst

  // 3) Pagina's ophalen
  const conc = shop.concurrency ?? 4;
  const multi = !!shop.multi;
  let i = 0, consecutiveBlocks = 0, stop = false;
  const worker = async () => {
    while (!stop && i < todo.length) {
      if (Date.now() > deadline) { stop = true; break; }
      const t = todo[i++];
      try {
        const r = await get(t.loc, { retries: 2, timeout: 30000, headers: shop.headers || {} });
        report.fetched++;
        const ex = extractProducts(r.text, t.loc);
        const prods = pickProduct(ex.products, t.loc, multi).filter((p) => p.name);
        if (prods.length) {
          consecutiveBlocks = 0;
          results.set(t.loc, prods.map((p) => ({ ...p, page_url: t.loc, lastmod: t.lastmod, sitemap_image: t.image, fetched_at: new Date().toISOString(), method: ex.method })));
        } else {
          const b = blockSignal(r.text, r.status);
          if (b) { report.blocked++; consecutiveBlocks++; }
          report.errors.noProduct = (report.errors.noProduct || 0) + 1;
        }
      } catch (e) {
        const k = e.status ? `http${e.status}` : "net";
        report.errors[k] = (report.errors[k] || 0) + 1;
        if (e.status === 403 || e.status === 429) consecutiveBlocks++;
        if (e.status === 404 || e.status === 410) results.delete(t.loc);
      }
      if (consecutiveBlocks >= 25) { log(`${shop.id}: geblokkeerd, stop`); report.aborted = "blocked"; stop = true; }
      if (report.fetched % 500 === 0 && report.fetched) log(`${shop.id}: ${report.fetched}/${todo.length} opgehaald, ${results.size} met product, ${Math.round((Date.now() - t0) / 60000)} min`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));

  // niet-bezochte URL's: vorige data houden
  for (const t of todo) {
    if (!results.has(t.loc) && prev.has(t.loc)) { results.set(t.loc, prev.get(t.loc)); report.kept++; }
  }
  return finish(shop, [...results.values()].flat(), report, outDir, t0);
}

function finish(shop, items, report, outDir, t0) {
  fs.mkdirSync(outDir, { recursive: true });
  const gz = zlib.gzipSync(items.map((p) => JSON.stringify({ site: shop.id, ...p })).join("\n") + "\n");
  fs.writeFileSync(`${outDir}/${shop.id}.ndjson.gz`, gz);
  report.products = items.length;
  report.withPrice = items.filter((p) => p.price != null).length;
  report.withGtin = items.filter((p) => p.gtin).length;
  report.minutes = Math.round((Date.now() - t0) / 6000) / 10;
  report.finished = new Date().toISOString();
  report.sample = items.slice(0, 3).map((p) => ({ name: p.name, price: p.price, url: p.product_url }));
  fs.writeFileSync(`${outDir}/${shop.id}.report.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ id: shop.id, products: report.products, fetched: report.fetched, reused: report.reused, kept: report.kept, errors: report.errors, minutes: report.minutes }));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const id = args[0];
  const shop = loadShop(id);
  if (opt("--sitemaps-only")) shop.sitemapsOnly = true;
  await crawlShop(shop, {
    prevFile: opt("--prev"),
    outDir: opt("--out", "out"),
    minutes: parseFloat(opt("--minutes", "330")),
    max: opt("--max") ? parseInt(opt("--max"), 10) : Infinity,
  });
}
