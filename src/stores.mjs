// Filialen van alle winkels uit OpenStreetMap (Overpass), gekoppeld aan config/shops.json via brand/wikidata.
//   node src/stores.mjs out/stores.ndjson.gz
import fs from "node:fs";
import zlib from "node:zlib";

const shops = JSON.parse(fs.readFileSync("config/shops.json", "utf8"));
const out = process.argv[2] || "out/stores.ndjson.gz";

const byWikidata = new Map();
const byBrand = new Map();
for (const s of shops) {
  for (const w of s.osm_wikidata || []) byWikidata.set(w, s.id);
  for (const b of s.osm_brands || []) byBrand.set(b.toLowerCase(), s.id);
}

const q = `[out:json][timeout:900];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
(nwr["shop"]["brand"](area.nl); nwr["amenity"="marketplace"]["brand"](area.nl););
out tags center;`;
const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
let data;
for (const ep of endpoints) {
  try {
    const r = await fetch(ep, {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "welkewinkel-scraper/0.1 (github.com/fkleinobbink)" },
      signal: AbortSignal.timeout(1000000),
    });
    if (!r.ok) { console.log(ep, r.status); continue; }
    data = await r.json();
    console.log("ok via", ep, data.elements.length);
    break;
  } catch (e) { console.log(ep, String(e)); }
}
if (!data) { console.error("Overpass niet bereikbaar"); process.exit(1); }

const rows = [];
const counts = {};
for (const el of data.elements) {
  const t = el.tags || {};
  const site = byWikidata.get(t["brand:wikidata"]) || byBrand.get(String(t.brand || "").toLowerCase());
  if (!site) continue;
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) continue;
  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ") || null;
  rows.push({
    site,
    osm_id: `${el.type}/${el.id}`,
    store_name: t.name || t.brand,
    brand_variant: t.brand,
    shop_type: t.shop || t.amenity,
    street,
    postal_code: t["addr:postcode"] ? t["addr:postcode"].replace(/\s+/g, "").toUpperCase() : null,
    city: t["addr:city"] || null,
    latitude: lat,
    longitude: lon,
    opening_hours: t.opening_hours || null,
    phone: t.phone || t["contact:phone"] || null,
    store_page_url: t.website || t["contact:website"] || null,
    maps_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    ref: t.ref || t["ref:vatin"] || null,
  });
  counts[site] = (counts[site] || 0) + 1;
}
fs.mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(out, zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
console.log(JSON.stringify({ stores: rows.length, shops: Object.keys(counts).length }));
const missing = shops.filter((s) => !counts[s.id]).map((s) => s.id);
if (missing.length) console.log("geen filialen voor:", missing.join(", "));
