// Controleert een (test)crawl: genoeg producten, uit meerdere categorieën, met prijs?
//   node src/check.mjs out/<id>.ndjson.gz [out/<id>.report.json]
import fs from "node:fs";
import { readNdjsonGz } from "./crawl.mjs";

const items = readNdjsonGz(process.argv[2]);
const report = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], "utf8")) : {};
const catOf = (p) => {
  if (p.breadcrumb) return p.breadcrumb.split(" > ").slice(0, 2).join(" > ");
  if (p.category) return p.category;
  try { const seg = new URL(p.product_url).pathname.split("/").filter(Boolean); return seg.length > 2 ? seg.slice(0, 2).join("/") : null; } catch { return null; }
};
const cats = new Map();
for (const p of items) { const c = catOf(p); if (c) cats.set(c, (cats.get(c) || 0) + 1); }
const pages = new Set(items.map((p) => p.page_url || p.product_url)).size;
const priced = items.filter((p) => typeof p.price === "number" && p.price > 0).length;
const res = {
  products: items.length,
  pages,
  categories: cats.size,
  pricePct: items.length ? Math.round((priced / items.length) * 100) : 0,
  gtinPct: items.length ? Math.round((items.filter((p) => p.gtin).length / items.length) * 100) : 0,
  imagePct: items.length ? Math.round((items.filter((p) => p.image_url).length / items.length) * 100) : 0,
  urls: report.urls,
  fetched: report.fetched,
  errors: report.errors,
  topCategories: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  sample: items.filter((_, i) => i % Math.max(1, Math.floor(items.length / 6)) === 0).slice(0, 6).map((p) => `${p.name} | ${p.price} | ${p.category || ""}`),
};
res.pass = res.products >= 20 && res.pages >= 10 && res.categories >= 4 && res.pricePct >= 70;
console.log(JSON.stringify(res, null, 1));
