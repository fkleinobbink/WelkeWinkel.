// Sligro (groothandel): geen Product-JSON-LD; gegevens staan in window.pageProperties.product_detail. Prijzen alleen na inloggen.
import { decodeHtml } from "../extract.mjs";

export function parse(html, url) {
  const m = html.match(/window\.pageProperties\.product_detail\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  let d; try { d = JSON.parse(m[1])[0]; } catch { return []; }
  if (!d?.product_name) return [];
  const title = (html.match(/<title>([^<|]*)/) || [])[1];
  const name = title ? decodeHtml(title).trim() : [d.product_brand, d.product_name].filter(Boolean).join(" ");
  return [{
    name,
    brand: d.product_brand || null,
    price: typeof d.product_price === "number" ? d.product_price : null,
    currency: "EUR",
    gtin: d.product_gtin || null,
    sku: d.product_id,
    amount: d.product_volume || null,
    image_url: d.image_url ? d.image_url.replace(/^http:/, "https:").replace("/small.png", "/large.png") : null,
    category: (d.product_categories || []).slice(-1)[0] || null,
    breadcrumb: (d.product_categories || []).join(" > ") || null,
    product_url: url,
  }];
}
