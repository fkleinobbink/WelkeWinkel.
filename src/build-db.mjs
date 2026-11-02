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
for (const r of read(`${dir}/stores.ndjson.gz`)) if (!ownStores.has(r.site)) addStore(r, "osm");
for (const site of ownStores) for (const r of read(`${dir}/${site}.stores.ndjson.gz`)) addStore({ ...r, site }, "retailer");

// 2) producten
const prodCounts = {};
const productKey = new Map(); // site|key -> id
for (const f of fs.readdirSync(dir).filter((f) => /^[a-z0-9_-]+\.ndjson\.gz$/.test(f) && f !== "stores.ndjson.gz")) {
  const site = f.replace(".ndjson.gz", "");
  const seen = new Set();
  for (const p of read(`${dir}/${f}`)) {
    if (!p.name) continue;
    const key = p.product_url || p.sku || p.name;
    if (seen.has(key)) continue;
    seen.add(key);
    const storeId = p.store_ref ? storeRefIndex.get(`${site}|${p.store_ref}`) ?? null : null;
    const res = insProd.run(site, s(p.name, 300), s(p.brand, 120), s(p.amount, 60), typeof p.price === "number" ? p.price : null, s(p.currency, 5), s(p.gtin, 60), s(p.sku, 80), s(p.category, 200), s(p.availability, 40), n(p.variants), s(p.product_url), s(p.image_url || p.sitemap_image), s(p.description, 500), storeId, s(p.first_seen || p.fetched_at) || now, s(p.fetched_at) || now);
    const id = Number(res.lastInsertRowid);
    for (const k of [p.product_url, p.sku, p.gtin].filter(Boolean)) productKey.set(`${site}|${k}`, id);
    prodCounts[site] = (prodCounts[site] || 0) + 1;
  }
}

// 3) voorraad per filiaal
const stockSites = new Set();
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
