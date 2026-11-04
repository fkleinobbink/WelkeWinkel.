// Poiesz webwinkel: geen Product-JSON-LD; gegevens in de Nuxt-payload (object met price/unitPrice/brandName/ean).
import { nuxtFind } from "../extract.mjs";

export function parse(html, url) {
  const p = nuxtFind(html, ["price", "unitPrice", "brandName", "ean", "mainCategoryId"]);
  if (!p?.name) return [];
  const num = (v) => (typeof v === "number" ? v : v != null && v !== "" ? parseFloat(String(v).replace(",", ".")) : null);
  const img = typeof p.image === "string" ? p.image : p.image?.url || null;
  return [{
    name: String(p.name).trim(),
    brand: p.brandName || null,
    price: num(p.price),
    regular_price: num(p.strikeThroughPrice) || null,
    promo: p.promotionLabel || null,
    currency: "EUR",
    gtin: p.ean ? String(p.ean) : null,
    sku: String(p.id ?? ""),
    amount: (p.packageDescription || p.displayUnit || "").replace(/\.00\b/, "").toLowerCase() || null,
    image_url: img,
    product_url: url,
  }];
}
