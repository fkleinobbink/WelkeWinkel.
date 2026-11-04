// Vomar: productpagina's renderen client-side, maar de subcategoriepagina's bevatten alle productkaarten
// (naam, inhoud, prijs) server-side. Deze parser leest alle kaarten van zo'n pagina.
import { decodeHtml } from "../extract.mjs";

export function parse(html, url) {
  const out = [];
  const crumbs = new URL(url).pathname.split("/").filter(Boolean).slice(1).map((s) => s.replace(/-/g, " "));
  const re = /<div class="col-md-4 product"[^>]*>\s*<a href="(\/producten\/[^"]+\/(\d+))"[\s\S]*?<img src="([^"]*)"[\s\S]*?<p class="description"[^>]*>([\s\S]*?)<\/p>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<p class="price[^"]*"[^>]*>\s*<span class="large"[^>]*>([\d.,]+)<\/span>\s*<span class="small"[^>]*>(\d*)<\/span>/g;
  for (const m of html.matchAll(re)) {
    const large = m[6].replace(/[.,]$/, "");
    out.push({
      name: decodeHtml(m[4]).replace(/\s+/g, " ").trim(),
      amount: decodeHtml(m[5]).replace(/\s+/g, " ").trim() || null,
      price: parseFloat(`${large}.${m[7] || "00"}`),
      currency: "EUR",
      sku: m[2],
      image_url: /DefaultPackShot/.test(m[3]) ? null : decodeHtml(m[3]).replace(/\?.*$/, ""),
      category: crumbs.slice(-1)[0] || null,
      breadcrumb: crumbs.join(" > ") || null,
      product_url: "https://www.vomar.nl" + m[1],
    });
  }
  return out;
}
