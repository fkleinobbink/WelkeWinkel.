// Haalt alle winkels met een brand-tag in NL op uit OpenStreetMap (Overpass)
// en schrijft: stores.csv (alle filialen) + brands.csv (aantal filialen per merk)
import fs from "node:fs";
const out = process.argv[2] || "probe-out";
fs.mkdirSync(out, { recursive: true });
const q = `[out:json][timeout:600];
area["ISO3166-1"="NL"][admin_level=2]->.nl;
nwr["shop"]["brand"](area.nl);
out tags center;`;
const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
let data;
for (const ep of endpoints) {
  try {
    const r = await fetch(ep, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "welkewinkel-scraper/0.1" } });
    if (!r.ok) { console.log(ep, r.status); continue; }
    data = await r.json(); console.log("ok via", ep); break;
  } catch (e) { console.log(ep, String(e)); }
}
if (!data) process.exit(1);
const esc = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const rows = [];
const brands = new Map();
for (const el of data.elements) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  const key = (t["brand:wikidata"] || "") + "|" + t.brand;
  const b = brands.get(key) || { brand: t.brand, wikidata: t["brand:wikidata"] || "", count: 0, shops: new Map(), website: "" };
  b.count++; b.shops.set(t.shop, (b.shops.get(t.shop) || 0) + 1);
  if (!b.website && (t["brand:website"] || t.website)) b.website = t["brand:website"] || t.website;
  brands.set(key, b);
  rows.push([el.type + "/" + el.id, t.brand, t["brand:wikidata"], t.shop, t.name, t["addr:street"], t["addr:housenumber"], t["addr:postcode"], t["addr:city"], lat, lon, t.website, t.opening_hours].map(esc).join(","));
}
fs.writeFileSync(`${out}/stores.csv`, "osm_id,brand,wikidata,shop,name,street,housenumber,postcode,city,lat,lon,website,opening_hours\n" + rows.join("\n") + "\n");
const bl = [...brands.values()].sort((a, b) => b.count - a.count);
fs.writeFileSync(`${out}/brands.csv`, "count,brand,wikidata,shop,website\n" + bl.map((b) => [b.count, b.brand, b.wikidata, [...b.shops.entries()].sort((x, y) => y[1] - x[1])[0][0], b.website].map(esc).join(",")).join("\n") + "\n");
fs.writeFileSync(`${out}/_index.txt`, `elements ${data.elements.length}\nbrands ${bl.length}\n`);
console.log(data.elements.length, bl.length);
