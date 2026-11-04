// Crawler voor één winkel.
//   node src/crawl.mjs <shopId> [--prev prev.ndjson.gz] [--out out/] [--minutes 330] [--max 1000]
// Leest config/shops.json + config/shops/<id>.json, schrijft out/<id>.ndjson.gz + out/<id>.report.json
// Incrementeel: URL's met dezelfde lastmod die recent zijn opgehaald worden hergebruikt;
// bij tijdgebrek worden de oudste eerst ververst en blijft de rest uit de vorige run staan.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { get, setHostDelay, blockSignal, setEngine, closeBrowser } from "./http.mjs";
import { walkSitemaps, robotsSitemaps } from "./sitemap.mjs";
import { extractProducts, guessAmount } from "./extract.mjs";

// Overzichtspagina's aflopen (bv. /producten/?offSet={offset}) en productlinks verzamelen.
// listing: { pages: ["https://x/producten/?offSet={offset}"], start: 0, step: 24, maxPages: 3000, link: "regex", base: "https://x" }
async function collectFromListing(shop, { deadline, log, max }) {
  const L = shop.listing;
  const linkRe = new RegExp(L.link, "g");
  const seen = new Set();
  const urls = [];
  let opened = 0;
  const listingDeadline = Date.now() + Math.min(90 * 60000, (deadline - Date.now()) * 0.4);
  for (const tpl of L.pages) {
    let empty = 0;
    for (let k = 0; k < (L.maxPages ?? 5000); k++) {
      if (Date.now() > listingDeadline) break; // laat tijd over voor productpagina's
      const offset = (L.start ?? 0) + k * (L.step ?? 1);
      const url = tpl.replace("{offset}", offset).replace("{page}", k + (L.pageStart ?? 0));
      let html;
      try { html = (await get(url, { retries: 2, timeout: 45000 })).text; opened++; } catch (e) { log(`listing fout ${url}: ${e.message}`); empty++; if (empty > 2) break; continue; }
      let fresh = 0;
      for (const m of html.matchAll(linkRe)) {
        const u = new URL(m[1] || m[0], L.base || `https://${shop.domain}`).href;
        if (!seen.has(u)) { seen.add(u); urls.push({ loc: u, lastmod: null }); fresh++; }
      }
      if (!fresh) { empty++; if (empty >= 2) break; } else empty = 0;
      if (opened % 100 === 0) log(`${shop.id}: ${opened} overzichtspagina's, ${urls.length} links`);
      if (urls.length >= max * 3 && max !== Infinity) break;
    }
  }
  return { urls, opened };
}

// Netjes stoppen bij annuleren/time-out van de Actions-job: alles wat binnen is wordt nog weggeschreven.
let STOP = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { if (!STOP) console.log(`signaal ${sig}: stoppen en opslaan`); STOP = true; });

// Site doorlopen via links: begin bij seeds (of de sitemap), volg categorie-links (follow) en verzamel productlinks (product).
// linkcrawl: { seeds: [...], seedSitemap: true, follow: "regex", product: "regex", pageParam: "page", maxPages: 4000 }
async function collectByLinkCrawl(shop, { deadline, log, max }) {
  const L = shop.linkcrawl;
  const base = L.base || `https://${shop.domain}`;
  const follow = new RegExp(L.follow, "i"), product = new RegExp(L.product, "i");
  const listingDeadline = Date.now() + Math.min(120 * 60000, (deadline - Date.now()) * 0.45);
  let seeds = [...(L.seeds || [])];
  if (L.seedSitemap) {
    const { urls } = await walkSitemaps(shop.sitemaps || [`${base}/sitemap.xml`], { urlFilter: (u) => follow.test(u) });
    seeds.push(...urls.map((u) => u.loc));
  }
  const queue = [...new Set(seeds)].map((u) => ({ u, page: 1 }));
  const seenPages = new Set(queue.map((q) => q.u));
  const prods = new Map();
  let opened = 0;
  while (queue.length && opened < (L.maxPages ?? 4000) && Date.now() < listingDeadline && !STOP) {
    const { u, page } = queue.shift();
    const url = page > 1 && L.pageParam ? `${u}${u.includes("?") ? "&" : "?"}${L.pageParam}=${page}` : u;
    let html;
    try { html = (await get(url, { retries: 1, timeout: 45000 })).text; opened++; } catch { continue; }
    let fresh = 0;
    // links uit href's én uit JSON (bv. JSON-LD ItemList "url")
    const found = [...html.matchAll(/href=["']([^"'#]+)["']/g), ...html.matchAll(/"(?:url|@id)"\s*:\s*"(https?:[^"]+)"/g)];
    for (const m of found) {
      let abs; try { abs = new URL(m[1].replace(/&amp;/g, "&").replace(/\\\//g, "/"), base).href.split("#")[0].replace(/^http:/, "https:"); } catch { continue; }
      if (!abs.startsWith(base)) continue;
      const isProd = product.test(abs);
      if (isProd) { const k = L.stripQuery ? abs.split("?")[0] : abs; if (!prods.has(k)) { prods.set(k, { loc: k, lastmod: null }); fresh++; } }
      if ((!isProd || L.followProducts) && follow.test(abs)) { const k = abs.split("?")[0]; if (!seenPages.has(k)) { seenPages.add(k); queue.push({ u: k, page: 1 }); } }
    }
    if (L.pageParam && fresh > 0 && page < (L.maxPagesPerList ?? 50)) queue.unshift({ u, page: page + 1 });
    if (opened % 100 === 0) log(`${shop.id}: ${opened} pagina's doorlopen, ${prods.size} productlinks, ${queue.length} in wachtrij`);
    if (max !== Infinity && prods.size >= max * 3) break;
  }
  log(`${shop.id}: linkcrawl ${opened} pagina's, ${prods.size} producten`);
  return { urls: [...prods.values()], opened };
}

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
  if (!out.amount) { try { out.amount = guessAmount(decodeURIComponent(new URL(pageUrl).pathname).replace(/[-_/]/g, " ")); } catch {} }
  delete out.group_name;
  return [out];
}

export async function crawlShop(shop, { prevFile, outDir = "out", minutes = 330, max = Infinity, log = console.log } = {}) {
  const t0 = Date.now();
  const deadline = t0 + minutes * 60000;
  const origin = `https://${shop.domain}`;
  const report = { id: shop.id, started: new Date().toISOString(), errors: {}, blocked: 0, fetched: 0, reused: 0, kept: 0, products: 0 };
  setHostDelay(new URL(origin).host, shop.delayMs ?? 200);
  if (shop.engine === "impersonate") setEngine("impersonate", shop.impersonate || "chrome");
  if (shop.engine === "browser") setEngine("browser", null, null, shop.browserOrigin || null);

  // Adapter? (src/adapters/<id>.mjs) -> volledig eigen logica
  const adapterPath = path.resolve(`src/adapters/${shop.adapter || shop.id}.mjs`);
  if (shop.strategy === "adapter" || (shop.adapter && fs.existsSync(adapterPath))) {
    const mod = await import(adapterPath);
    const items = [];
    let lastCp = Date.now();
    for await (const p of mod.products({ shop, log, deadline, max, get, report })) {
      items.push({ ...p, fetched_at: new Date().toISOString() });
      if (items.length >= max || STOP) break;
      if (Date.now() - lastCp > 10 * 60000) { lastCp = Date.now(); checkpoint(shop, () => items, outDir); }
    }
    return finish(shop, items, report, outDir, t0);
  }

  // 1) URL's verzamelen: uit overzichtspagina's (listing) of uit sitemaps
  let urls, opened = 0;
  if (shop.listing) {
    ({ urls, opened } = await collectFromListing(shop, { deadline, log, max }));
  } else if (shop.linkcrawl) {
    ({ urls, opened } = await collectByLinkCrawl(shop, { deadline, log, max }));
  } else {
  let roots = shop.sitemaps;
  if (!roots || !roots.length) {
    const r = await robotsSitemaps(origin);
    roots = r.sitemaps.length ? r.sitemaps : [`${origin}/sitemap.xml`];
  }
  const smInc = rx(shop.sitemapInclude), smExc = rx(shop.sitemapExclude);
  const urlInc = rx(shop.urlInclude), urlExc = rx(shop.urlExclude);
  ({ urls, opened } = await walkSitemaps(roots, {
    sitemapFilter: (u) => (!smInc || smInc.test(u)) && (!smExc || !smExc.test(u)),
    urlFilter: (u) => (!urlInc || urlInc.test(u)) && (!urlExc || !urlExc.test(u)),
    log,
  }));
  }
  // URL's herschrijven als de sitemap verouderde paden bevat (bv. DekaMarkt /boodschappen/producten/ -> /producten/)
  for (const [from, to] of shop.urlRewrite || []) { const re = new RegExp(from); for (const u of urls) u.loc = u.loc.replace(re, to); }
  const seen = new Set();
  let targets = urls.filter((u) => (seen.has(u.loc) ? false : seen.add(u.loc)));
  report.sitemapsOpened = opened;
  report.urls = targets.length;
  log(`${shop.id}: ${targets.length} product-URL's uit ${opened} sitemaps`);
  if (targets.length > max) {
    // testmodus: gelijkmatig verspreid over de sitemap, zodat we niet alleen categoriepagina's pakken
    const step = targets.length / max;
    targets = Array.from({ length: max }, (_, k) => targets[Math.floor(k * step)]);
  }

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
    const sameVersion = !t.lastmod || shop.ignoreLastmod || old?.[0].lastmod === t.lastmod;
    if (old && sameVersion && age < reuseDays) {
      results.set(t.loc, old);
      report.reused++;
    } else todo.push({ ...t, age });
  }
  todo.sort((a, b) => b.age - a.age); // nooit opgehaald / oudste eerst

  // 3) Pagina's ophalen (eigen parser per winkel mogelijk: src/parsers/<naam>.mjs)
  const parser = shop.parser ? await import(path.resolve(`src/parsers/${shop.parser}.mjs`)) : null;
  const conc = shop.concurrency ?? 4;
  const multi = !!shop.multi;
  let i = 0, consecutiveBlocks = 0, stop = false, pausedUntil = 0, cooldowns = 0, lastCheckpoint = Date.now();
  let hostDelay = shop.delayMs ?? 200;
  const baseDelay = hostDelay;
  let okSinceSlow = 0;
  const worker = async () => {
    while (!stop && i < todo.length) {
      if (Date.now() > deadline || STOP) { stop = true; break; }
      if (Date.now() < pausedUntil) { await new Promise((r) => setTimeout(r, pausedUntil - Date.now())); continue; }
      const t = todo[i++];
      try {
        const r = await get(t.loc, { retries: 2, timeout: 30000, headers: shop.headers || {} });
        report.fetched++;
        let ex = parser ? { method: shop.parser, products: parser.parse(r.text, t.loc) } : extractProducts(r.text, t.loc);
        if (parser && !ex.products.length) ex = extractProducts(r.text, t.loc);
        // JSON-roundtrip: strings die met regex uit de HTML komen houden anders de hele pagina in het geheugen vast (V8 sliced strings)
        const prods = JSON.parse(JSON.stringify(pickProduct(ex.products, t.loc, multi).filter((p) => p.name)));
        if (prods.length) {
          consecutiveBlocks = 0;
          // na een blokkade weer langzaam versnellen: elke 150 goede pagina's 25% minder wachttijd, tot de basis
          if (hostDelay > baseDelay && ++okSinceSlow >= 150) {
            okSinceSlow = 0;
            hostDelay = Math.max(baseDelay, Math.round(hostDelay * 0.75));
            setHostDelay(new URL(origin).host, hostDelay);
          }
          results.set(t.loc, prods.map((p) => ({ ...p, page_url: t.loc, lastmod: t.lastmod, sitemap_image: t.image, fetched_at: new Date().toISOString(), method: ex.method })));
        } else {
          const b = blockSignal(r.text, r.status);
          if (b) { report.blocked++; consecutiveBlocks++; }
          report.errors.noProduct = (report.errors.noProduct || 0) + 1;
          (report.noProductSamples ||= []).length < 5 && report.noProductSamples.push({ url: t.loc, status: r.status, bytes: r.text.length, title: (r.text.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || null, block: b });
        }
      } catch (e) {
        const k = e.status ? `http${e.status}` : "net";
        report.errors[k] = (report.errors[k] || 0) + 1;
        if (e.status === 403 || e.status === 429) consecutiveBlocks++;
        if (e.status === 404 || e.status === 410) results.delete(t.loc);
      }
      if (consecutiveBlocks >= 12) {
        // eerst afkoelen en trager gaan; pas na 3 pogingen echt stoppen
        if (cooldowns >= 3) { log(`${shop.id}: geblokkeerd, stop`); report.aborted = "blocked"; stop = true; }
        else {
          cooldowns++; consecutiveBlocks = 0;
          hostDelay = Math.min(hostDelay * 2 + 500, 10000);
          setHostDelay(new URL(origin).host, hostDelay);
          pausedUntil = Date.now() + 120000 * cooldowns;
          log(`${shop.id}: geblokkeerd, pauze ${2 * cooldowns} min, vertraging nu ${hostDelay}ms`);
          i = Math.max(0, i - 12); // mislukte pagina's opnieuw proberen
        }
      }
      if (Date.now() - lastCheckpoint > 10 * 60000) { lastCheckpoint = Date.now(); checkpoint(shop, () => [...new Map([...prev, ...results]).values()].flat(), outDir); }
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

// tussentijds opslaan, zodat bij annuleren/time-out niet alles verloren gaat
function checkpoint(shop, getItems, outDir) {
  try {
    const items = getItems();
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(`${outDir}/${shop.id}.ndjson.gz.tmp`, zlib.gzipSync(items.map((p) => JSON.stringify({ site: shop.id, ...p })).join("\n") + "\n"));
    fs.renameSync(`${outDir}/${shop.id}.ndjson.gz.tmp`, `${outDir}/${shop.id}.ndjson.gz`);
    console.log(`${shop.id}: tussenstand opgeslagen (${items.length})`);
  } catch (e) { console.log("checkpoint mislukt", e.message); }
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
  await closeBrowser();
}
