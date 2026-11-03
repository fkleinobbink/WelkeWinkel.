// Bouwt scraper.db (SQLite) uit alle ndjson.gz-bestanden in een map.
//   node src/build-db.mjs <map met *.ndjson.gz> <scraper.db>
// Bestanden:  <shop>.ndjson.gz (producten), stores.ndjson.gz (OSM-filialen),
//             <shop>.stores.ndjson.gz (eigen filialenlijst winkel, vervangt OSM), <shop>.stock.ndjson.gz (voorraad per filiaal)
import fs from "node:fs";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const dir = process.argv[2] || "data";
const dbFile = process.argv[3] || "scraper.db";
const shops = JSON.parse(fs.readFileSync("config/shops.json", "utf8"));
const shopById = new Map(shops.map((s) => [s.id, s]));

const read = (f) =>
  fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString("utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
const db = new DatabaseSync(dbFile);
db.exec(`
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE sites (
  name TEXT PRIMARY KEY,            -- shop-id, bv. 'ikea'
  display_name TEXT, base_url TEXT, category TEXT,
  product_count INTEGER DEFAULT 0, store_count INTEGER DEFAULT 0, stock_level TEXT, updated_at TEXT
);
CREATE TABLE store_locations (
  id INTEGER PRIMARY KEY, site TEXT, store_name TEXT, street TEXT, postal_code TEXT, city TEXT,
  latitude REAL, longitude REAL, maps_url TEXT, store_page_url TEXT,
  osm_id TEXT, store_ref TEXT, opening_hours TEXT, phone TEXT, source TEXT
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY, site TEXT, name TEXT, brand TEXT, amount TEXT, price REAL, currency TEXT,
  gtin TEXT, sku TEXT, category TEXT, availability TEXT, variants INTEGER,
  product_url TEXT, image_url TEXT, description TEXT,
  store_id INTEGER,                 -- gevuld als product maar in 1 filiaal ligt (bv. kringloop)
  created_at TEXT, updated_at TEXT
);
CREATE TABLE stock (
  product_id INTEGER, store_id INTEGER, status TEXT, quantity INTEGER, checked_at TEXT,
  PRIMARY KEY (product_id, store_id)
);
`);

const now = new Date().toISOString();
const insStore = db.prepare(`INSERT INTO store_locations (site, store_name, street, postal_code, city, latitude, longitude, maps_url, store_page_url, osm_id, store_ref, opening_hours, phone, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insProd = db.prepare(`INSERT INTO products (site, name, brand, amount, price, currency, gtin, sku, category, availability, variants, product_url, image_url, description, store_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insStock = db.prepare(`INSERT OR REPLACE INTO stock (product_id, store_id, status, quantity, checked_at) VALUES (?,?,?,?,?)`);
const n = (v) => (v === undefined || v === "" ? null : v);
const s = (v, max = 1000) => (v == null ? null : String(v).slice(0, max));

db.exec("BEGIN");
// 1) filialen: eigen lijst per winkel heeft voorrang op OSM
const ownStores = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".stores.ndjson.gz")).map((f) => f.replace(".stores.ndjson.gz", "")));
const storeRefIndex = new Map(); // site|store_ref -> id
const storeCounts = {};
const addStore = (r, source) => {
  const res = insStore.run(r.site, s(r.store_name), s(r.street), s(r.postal_code), s(r.city), n(r.latitude), n(r.longitude), s(r.maps_url), s(r.store_page_url), s(r.osm_id), s(r.store_ref ?? r.ref), s(r.opening_hours), s(r.phone), source);
  const id = Number(res.lastInsertRowid);
  if (r.store_ref ?? r.ref) storeRefIndex.set(`${r.site}|${r.store_ref ?? r.ref}`, id);
  storeCounts[r.site] = (storeCounts[r.site] || 0) + 1;
  return id;
};
// plaats aanvullen als OSM geen adres heeft: dichtstbijzijnde postcodegebied (PC4)
const pc4 = fs.existsSync("config/4pp.csv")
  ? fs.readFileSync("config/4pp.csv", "utf8").split("\n").slice(1).map((l) => l.match(/^\d+,(\d{4}),"([^"]*)",.*,([\d.]+),([\d.]+),"([^"]*)"\s*$/)).filter((m) => m && m[5] !== "Postbus").map((m) => ({ pc: m[1], city: m[2], lat: +m[3], lon: +m[4] }))
  : [];
function nearestPc4(lat, lon) {
  let best = null, bd = Infinity;
  const cl = Math.cos((lat * Math.PI) / 180);
  for (const p of pc4) { const d = (p.lat - lat) ** 2 + ((p.lon - lon) * cl) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
}
let filled = 0;
for (const r of read(`${dir}/stores.ndjson.gz`)) {
  if (ownStores.has(r.site)) continue;
  if (!r.city && pc4.length && r.latitude) { const n = nearestPc4(r.latitude, r.longitude); if (n) { r.city = n.city; r.pc4 = n.pc; filled++; } }
  addStore(r, "osm");
}
if (filled) console.log(`plaats aangevuld voor ${filled} filialen`);
for (const site of ownStores) for (const r of read(`${dir}/${site}.stores.ndjson.gz`)) addStore({ ...r, site }, "retailer");

// 2) producten
const stripTags = (v) => (v == null ? v : String(v).replace(/<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/gi, " ").replace(/\s+/g, " ").trim());
const variantKey = (p) => [String(p.name || "").toLowerCase().replace(/\s+/g, " ").trim(), String(p.amount || "").toLowerCase(), String(p.brand || "").toLowerCase()].join("|");
// varianten (zelfde naam/inhoud/merk, andere kleur/maat-URL) samenvoegen tot 1 product, tenzij ze in verschillende filialen liggen
function collapseVariants(list) {
  const groups = new Map();
  for (const p of list) {
    const k = variantKey(p) + "|" + (p.store_hint || p.store_ref || "");
    const g = groups.get(k);
    if (!g) { groups.set(k, { ...p, variants: p.variants || 1, variant_urls: [] }); continue; }
    g.variants += p.variants || 1;
    if (g.variant_urls.length < 20) g.variant_urls.push(p.product_url);
    if (typeof p.price === "number" && (g.price == null || p.price < g.price)) g.price = p.price;
    if (!g.gtin && p.gtin) g.gtin = p.gtin;
    if (!g.image_url && p.image_url) g.image_url = p.image_url;
    if (/instock/i.test(p.availability || "")) g.availability = p.availability;
  }
  return [...groups.values()].map((g) => (g.variants === 1 ? { ...g, variants: null } : g));
}
const stockSites = new Set();
const prodCounts = {};
// filiaal zoeken op plaatsnaam/naam (voor winkels waar elk item in 1 filiaal ligt, bv. kringloop)
const storesBySite = new Map();
for (const r of db.prepare("SELECT id, site, store_name, city, street FROM store_locations").all()) {
  if (!storesBySite.has(r.site)) storesBySite.set(r.site, []);
  storesBySite.get(r.site).push(r);
}
const norm = (x) => String(x || "").toLowerCase().replace(/&#8217;|’|'/g, "").replace(/a.dam/g, "amsterdam").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const hintCache = new Map();
function storeByHint(site, hint) {
  const k = site + "|" + hint;
  if (hintCache.has(k)) return hintCache.get(k);
  const h = norm(hint);
  const list = storesBySite.get(site) || [];
  const words = h.split(" ");
  let best = null, bestScore = 0;
  for (const st of list) {
    const hay = norm([st.store_name, st.city, st.street].join(" "));
    const score = words.filter((w) => w.length > 2 && hay.includes(w)).length;
    if (score > bestScore) { best = st.id; bestScore = score; }
  }
  hintCache.set(k, best);
  return best;
}
const productKey = new Map(); // site|key -> id
for (const f of fs.readdirSync(dir).filter((f) => /^[a-z0-9_-]+\.ndjson\.gz$/.test(f) && f !== "stores.ndjson.gz")) {
  const site = f.replace(".ndjson.gz", "");
  const seen = new Set();
  const raw = read(`${dir}/${f}`).filter((p) => p.name).map((p) => ({ ...p, name: stripTags(p.name), price: typeof p.price === "number" && p.price > 0 && p.price < 100000 ? p.price : null }));
  for (const p of collapseVariants(raw)) {
    if (!p.name) continue;
    const key = p.product_url || p.sku || p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    let storeId = p.store_ref ? storeRefIndex.get(`${site}|${p.store_ref}`) ?? null : null;
    if (!storeId && p.store_hint) storeId = storeByHint(site, p.store_hint);
    const res = insProd.run(site, s(p.name, 300), s(p.brand, 120), s(p.amount, 60), typeof p.price === "number" ? p.price : null, s(p.currency, 5), s(p.gtin, 60), s(p.sku, 80), s(p.category, 200), s(p.availability, 40), n(p.variants), s(p.product_url), s(p.image_url || p.sitemap_image), s(p.description, 500), storeId, s(p.first_seen || p.fetched_at) || now, s(p.fetched_at) || now);
    const id = Number(res.lastInsertRowid);
    for (const k of [p.product_url, p.sku, p.gtin].filter(Boolean)) productKey.set(`${site}|${k}`, id);
    if (storeId) { insStock.run(id, storeId, "in_stock", 1, s(p.fetched_at) || now); stockSites.add(site); }
    prodCounts[site] = (prodCounts[site] || 0) + 1;
  }
}

// 3) voorraad per filiaal
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".stock.ndjson.gz"))) {
  const site = f.replace(".stock.ndjson.gz", "");
  for (const r of read(`${dir}/${f}`)) {
    const pid = productKey.get(`${site}|${r.product_key}`);
    const sid = storeRefIndex.get(`${site}|${r.store_ref}`);
    if (!pid || !sid) continue;
    insStock.run(pid, sid, s(r.status, 30), n(r.quantity), s(r.checked_at) || now);
    stockSites.add(site);
  }
}

// 4) sites
const insSite = db.prepare(`INSERT INTO sites (name, display_name, base_url, category, product_count, store_count, stock_level, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
for (const sh of shops) {
  insSite.run(sh.id, sh.name, `https://${sh.domain}`, sh.category, prodCounts[sh.id] || 0, storeCounts[sh.id] || 0, stockSites.has(sh.id) ? "store" : prodCounts[sh.id] ? "chain" : null, now);
}
db.exec("COMMIT");
db.exec(`
CREATE INDEX idx_products_site ON products(site);
CREATE INDEX idx_products_gtin ON products(gtin);
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_stores_site ON store_locations(site);
CREATE INDEX idx_stock_store ON stock(store_id);
`);
db.close();

const totalP = Object.values(prodCounts).reduce((a, b) => a + b, 0);
const totalS = Object.values(storeCounts).reduce((a, b) => a + b, 0);
const lines = shops
  .map((sh) => ({ id: sh.id, name: sh.name, p: prodCounts[sh.id] || 0, st: storeCounts[sh.id] || 0, stock: stockSites.has(sh.id) }))
  .sort((a, b) => b.p - a.p);
const md = [
  `# Database-status`,
  ``,
  `Gebouwd: ${now}`,
  ``,
  `**${totalP.toLocaleString("nl-NL")} producten · ${totalS.toLocaleString("nl-NL")} filialen · ${lines.filter((l) => l.p).length}/${shops.length} winkels met producten**`,
  ``,
  `| Winkel | Producten | Filialen | Voorraad per filiaal |`,
  `|---|---:|---:|:---:|`,
  ...lines.map((l) => `| ${l.name} | ${l.p.toLocaleString("nl-NL")} | ${l.st} | ${l.stock ? "✅" : ""} |`),
].join("\n");
fs.writeFileSync("STATUS.md", md + "\n");
console.log(`producten ${totalP}, filialen ${totalS}`);
