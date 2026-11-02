// Productdata uit HTML halen: JSON-LD (schema.org Product) -> meta-tags -> microdata.

export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1].trim().replace(/^<!--|-->$/g, "");
    try {
      out.push(JSON.parse(raw));
    } catch {
      try { out.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " "))); } catch {}
    }
  }
  return out;
}

function flatten(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, acc)); return acc; }
  if (typeof node !== "object") return acc;
  acc.push(node);
  if (node["@graph"]) flatten(node["@graph"], acc);
  if (node.mainEntity) flatten(node.mainEntity, acc);
  if (node.itemListElement) flatten(node.itemListElement.map?.((x) => x.item || x) || [], acc);
  return acc;
}

const isType = (n, t) => {
  const ty = n["@type"];
  return Array.isArray(ty) ? ty.some((x) => String(x).toLowerCase() === t) : String(ty || "").toLowerCase() === t;
};

export function parsePrice(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).replace(/[^\d.,-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => {
  v = first(v);
  if (v == null) return null;
  if (typeof v === "object") return v.name || v["@id"] || v.url || null;
  return String(v).trim() || null;
};

function pickOffer(offers) {
  if (!offers) return {};
  const list = (Array.isArray(offers) ? offers : [offers]).flatMap((o) => (o && o.offers ? [o, ...[].concat(o.offers)] : [o]));
  let best = null;
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const price = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price ?? first(o.priceSpecification)?.price);
    if (price == null) continue;
    if (!best || price < best.price) best = { price, currency: o.priceCurrency || first(o.priceSpecification)?.priceCurrency || null, availability: str(o.availability), sku: o.sku || null, gtin: o.gtin13 || o.gtin || null };
  }
  return best || {};
}

const UNIT_RE = /(\d+(?:[.,]\d+)?\s?(?:x\s?\d+(?:[.,]\d+)?\s?)?(?:kg|g|gr|gram|mg|l|liter|ltr|cl|ml|m|cm|mm|m2|m²|st|stuks|stuk|rol|rollen|tabl|caps|w|v|mah)\b)/i;

export function guessAmount(name) {
  const m = String(name || "").match(UNIT_RE);
  return m ? m[1] : null;
}

function normalizeProduct(p, pageUrl) {
  const offer = pickOffer(p.offers);
  const gtin = p.gtin13 || p.gtin || p.gtin14 || p.gtin12 || p.gtin8 || p.ean || offer.gtin || null;
  const name = str(p.name);
  if (!name) return null;
  const availability = offer.availability ? offer.availability.replace(/^https?:\/\/schema\.org\//i, "") : null;
  let image = first(p.image);
  if (image && typeof image === "object") image = image.url || image.contentUrl || null;
  return {
    name,
    brand: str(p.brand),
    price: offer.price ?? null,
    currency: offer.currency || null,
    availability,
    gtin: gtin ? String(gtin) : null,
    sku: p.sku ? String(p.sku) : offer.sku ? String(offer.sku) : p.productID ? String(p.productID) : p.mpn ? String(p.mpn) : null,
    image_url: image || null,
    category: str(p.category),
    amount: str(p.size) || (p.weight ? [p.weight.value, p.weight.unitCode || p.weight.unitText].filter(Boolean).join(" ") : null) || guessAmount(name),
    product_url: p.url && /^https?:/.test(p.url) ? p.url : pageUrl,
    description: p.description ? String(p.description).slice(0, 500) : null,
    rating: p.aggregateRating ? parsePrice(p.aggregateRating.ratingValue) : null,
  };
}

// Geeft een lijst producten terug (bij ProductGroup: varianten apart).
export function productsFromJsonLd(html, pageUrl) {
  const nodes = flatten(jsonLdBlocks(html));
  const out = [];
  for (const n of nodes) {
    if (isType(n, "productgroup") && Array.isArray(n.hasVariant) && n.hasVariant.length) {
      for (const v of n.hasVariant) {
        const merged = { brand: n.brand, image: n.image, category: n.category, ...v, name: v.name || n.name };
        const p = normalizeProduct(merged, pageUrl);
        if (p) out.push({ ...p, group_id: n.productGroupID || n.sku || null });
      }
    } else if (isType(n, "product") || isType(n, "individualproduct") || isType(n, "productmodel") || isType(n, "book") || isType(n, "vehicle")) {
      const p = normalizeProduct(n, pageUrl);
      if (p) out.push(p);
    }
  }
  return out;
}

function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/[:.]/g, "\\$&")}["'][^>]*>`, "i");
  const m = html.match(re);
  if (!m) return null;
  const c = m[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeHtml(c[1]) : null;
}

export function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

export function productFromMeta(html, pageUrl) {
  const price = parsePrice(meta(html, "product:price:amount") || meta(html, "og:price:amount") || meta(html, "price"));
  const name = meta(html, "og:title") || (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
  if (!name || price == null) return null;
  return {
    name: decodeHtml(name).trim(),
    price,
    currency: meta(html, "product:price:currency") || meta(html, "og:price:currency") || "EUR",
    image_url: meta(html, "og:image"),
    brand: meta(html, "product:brand") || meta(html, "og:brand"),
    gtin: meta(html, "product:ean") || meta(html, "gtin13"),
    sku: meta(html, "product:retailer_item_id") || meta(html, "sku"),
    availability: meta(html, "product:availability") || meta(html, "og:availability"),
    product_url: meta(html, "og:url") || pageUrl,
    amount: guessAmount(name),
  };
}

export function extractProducts(html, pageUrl) {
  const ld = productsFromJsonLd(html, pageUrl);
  if (ld.length) return { method: "jsonld", products: ld };
  const m = productFromMeta(html, pageUrl);
  if (m) return { method: "meta", products: [m] };
  return { method: null, products: [] };
}

export function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
