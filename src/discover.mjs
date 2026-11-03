// Discovery-agent: zoekt per winkel uit hoe de producten te vinden zijn.
// robots.txt -> sitemaps -> product-sitemaps herkennen -> paar productpagina's testen.
// Output per winkel: rapport + voorgestelde config.
import fs from "node:fs";
import { get, blockSignal, setEngine } from "./http.mjs";
import { robotsSitemaps, parseSitemap } from "./sitemap.mjs";
import { extractProducts, nextData } from "./extract.mjs";

const PRODUCT_HINT = /product|pdp|artikel|article|item|sku|catalog|assortiment|-p-|\/p\//i;
const NON_PRODUCT = /categor|category|store|winkel|filial|blog|recipe|recept|page|content|brand|merk|static|image|video|faq|landing|cms|service|inspiratie|help|news|nieuws|tag|search/i;

function score(loc) {
  let s = 0;
  if (PRODUCT_HINT.test(loc)) s += 2;
  if (NON_PRODUCT.test(loc)) s -= 2;
  if (/\bnl[-_]?nl\b|\/nl\/|_nl\.|-nl\.|nl\.xml|nl_NL/i.test(loc)) s += 1;
  if (/\/(de|fr|en|be|es|it|pl|cz|at|ch|hu|sk|ro|hr|pt)[-_](de|fr|en|be|es|it|pl|cz|at|ch|hu|sk|ro|hr|pt)\b|[-_](de|fr|be-fr|be|en)\.xml/i.test(loc) && !/nl/i.test(loc)) s -= 3;
  return s;
}

async function tryGet(url, opts) {
  try {
    const r = await get(url, { retries: 1, timeout: 30000, ...opts });
    return { ok: true, status: r.status, text: r.text, url: r.url };
  } catch (e) {
    return { ok: false, status: e.status || 0, text: e.body || "", error: e.message };
  }
}

export async function discover(shop, { log = console.log } = {}) {
  const origin = `https://${shop.domain}`;
  const rep = { id: shop.id, name: shop.name, origin, steps: [], sitemaps: [], productSitemaps: [], samples: [], verdict: null };
  const home = await tryGet(origin + "/");
  const homeText = home.text || "";
  rep.home = { status: home.status, block: blockSignal(home.text, home.status), finalUrl: home.url, bytes: home.text.length, nextjs: homeText.includes("__NEXT_DATA__") };
  const robots = await robotsSitemaps(origin);
  rep.robotsSitemaps = robots.sitemaps;
  rep.robotsDisallowAll = /^\s*user-agent:\s*\*\s*$[\s\S]*?^\s*disallow:\s*\/\s*$/im.test(robots.text);
  let roots = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  // filter talen bij multi-language robots (Action e.d.)
  const nlRoots = roots.filter((r) => /nl[-_]nl|\/nl\/|nl\.xml|-nl|_nl/i.test(r));
  if (roots.length > 6 && nlRoots.length) roots = nlRoots;

  // Breadth-first, max 2 niveaus diep, max ~25 sitemaps openen
  const queue = roots.map((r) => ({ loc: r, depth: 0 }));
  const seen = new Set();
  let opened = 0;
  const leafs = [];
  while (queue.length && opened < 25) {
    queue.sort((a, b) => score(b.loc) - score(a.loc));
    const { loc, depth } = queue.shift();
    if (seen.has(loc)) continue;
    seen.add(loc);
    const r = await tryGet(loc, { timeout: 60000 });
    opened++;
    if (!r.ok) { rep.sitemaps.push({ loc, status: r.status, error: r.error }); continue; }
    const { isIndex, entries } = parseSitemap(r.text, 20000);
    r.text = null;
    rep.sitemaps.push({ loc, isIndex, entries: entries.length, sample: entries.slice(0, 3).map((e) => e.loc) });
    if (isIndex) {
      if (depth < 3) entries.forEach((e) => queue.push({ loc: e.loc, depth: depth + 1 }));
      rep.indexChildren = (rep.indexChildren || []).concat(entries.map((e) => e.loc)).slice(0, 400);
    } else if (entries.length) {
      leafs.push({ loc, entries });
    }
  }

  // Product-URL's kiezen: leaf-sitemaps met hoogste score, anders URL's die op product lijken
  leafs.sort((a, b) => score(b.loc) - score(a.loc));
  const productLeafs = leafs.filter((l) => score(l.loc) > 0);
  rep.productSitemaps = productLeafs.map((l) => ({ loc: l.loc, entries: l.entries.length }));
  let candidates = (productLeafs.length ? productLeafs : leafs).flatMap((l) => l.entries.map((e) => e.loc));
  const prodLike = candidates.filter((u) => /\/p\/|\/product|\/pdp|\/artikel|-p-|\d{5,}|\/wi\d+/i.test(u) && !NON_PRODUCT.test(new URL(u).pathname.split("/").slice(0, 2).join("/")));
  if (prodLike.length >= 3) candidates = prodLike;
  const picks = [];
  for (const idx of [0.13, 0.5, 0.87]) {
    const u = candidates[Math.floor(candidates.length * idx)];
    if (u && !picks.includes(u)) picks.push(u);
  }
  for (const u of picks) {
    const r = await tryGet(u);
    const ex = r.ok ? extractProducts(r.text, u) : { method: null, products: [] };
    const nd = r.ok ? nextData(r.text) : null;
    rep.samples.push({
      url: u,
      status: r.status,
      block: blockSignal(r.text, r.status),
      bytes: r.text.length,
      method: ex.method,
      product: ex.products[0] || null,
      variants: ex.products.length,
      nextData: !!nd,
    });
  }
  const good = rep.samples.filter((s) => s.product && s.product.name && s.product.price != null);
  rep.estimatedProducts = productLeafs.reduce((a, l) => a + l.entries.length, 0) || null;
  if (rep.home.block && !good.length) rep.verdict = `blocked:${rep.home.block}`;
  else if (good.length >= 2) rep.verdict = `ok:${good[0].method}`;
  else if (good.length === 1) rep.verdict = `partial:${good[0].method}`;
  else if (!leafs.length) rep.verdict = "no-sitemap";
  else rep.verdict = "needs-adapter";

  rep.suggestedConfig = {
    id: shop.id,
    strategy: "sitemap",
    sitemaps: roots,
    sitemapInclude: productLeafs.length ? commonPattern(productLeafs.map((l) => l.loc)) : null,
    urlInclude: prodLike.length >= 3 ? commonUrlPattern(prodLike) : null,
  };
  return rep;
}

function commonPattern(locs) {
  // simpele heuristiek: gemeenschappelijk woord in pad
  const words = ["product", "pdp", "artikel", "article", "sku", "catalog"];
  for (const w of words) if (locs.every((l) => l.toLowerCase().includes(w))) return w;
  return null;
}
function commonUrlPattern(urls) {
  for (const p of ["/p/", "/product/", "/products/", "/pdp/", "/artikel/", "-p-", "/producten/"]) if (urls.filter((u) => u.includes(p)).length / urls.length > 0.8) return p;
  return null;
}

// CLI: node src/discover.mjs config/shops.json out [ids...]
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.ENGINE === "browser") setEngine("browser");
  else if (process.env.ENGINE) setEngine("impersonate", process.env.ENGINE);
  const shops = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = process.argv[3] || "out";
  const only = process.argv.slice(4);
  fs.mkdirSync(`${out}/discover`, { recursive: true });
  const list = only.length ? shops.filter((s) => only.includes(s.id)) : shops;
  const queue = [...list];
  const summary = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const s = queue.shift();
        const t = Date.now();
        console.log('start', s.id);
        let rep;
        try {
          rep = await Promise.race([discover(s), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 240000))]);
        } catch (e) {
          rep = { id: s.id, verdict: "error:" + e.message };
        }
        fs.writeFileSync(`${out}/discover/${s.id}.json`, JSON.stringify(rep, null, 1));
        const line = [s.id, rep.verdict, rep.home?.status, rep.home?.block || "", rep.estimatedProducts ?? "", (rep.samples || []).map((x) => `${x.status}/${x.method || "-"}`).join(" "), Math.round((Date.now() - t) / 1000) + "s"].join("\t");
        summary.push(line);
        console.log(line);
      }
    })
  );
  fs.writeFileSync(`${out}/_index.txt`, summary.sort().join("\n") + "\n");
}
