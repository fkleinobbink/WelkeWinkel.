// Odin: geen JSON-LD; gegevens staan als <dt>Merk/Inhoud/Prijs</dt><dd><span class="price">…</span></dd> in de HTML.
import { decodeHtml, parsePrice } from "../extract.mjs";

const field = (html, label) => {
  const re = new RegExp(`<dt class="price-label">\\s*${label}\\s*</dt>\\s*<dd[^>]*>\\s*<span class="price">([^<]*)</span>`, "i");
  const m = html.match(re);
  return m ? decodeHtml(m[1]).trim() : null;
};
const meta = (html, p) => { const m = html.match(new RegExp(`<meta property="og:${p}"\\s+content="([^"]*)"`, "i")); return m ? decodeHtml(m[1]) : null; };

export function parse(html, url) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const name = h1 ? decodeHtml(h1[1].replace(/<[^>]+>/g, "")).trim() : meta(html, "title");
  const priceTxt = field(html, "Prijs");
  if (!name || !priceTxt) return [];
  const member = field(html, "Ledenprijs");
  const path = new URL(url).pathname.split("/").filter(Boolean);
  const id = (url.match(/\/-(\d+)-/) || [])[1] || null;
  return [{
    name,
    brand: field(html, "Merk"),
    amount: field(html, "Inhoud"),
    price: parsePrice(priceTxt),
    member_price: member ? parsePrice(member) : null,
    currency: "EUR",
    sku: id,
    image_url: meta(html, "image"),
    description: (meta(html, "description") || "").slice(0, 500) || null,
    category: path.length > 3 ? path[2].replace(/-/g, " ") : null,
    breadcrumb: path.slice(1, -1).map((x) => x.replace(/-/g, " ")).join(" > ") || null,
    product_url: url,
  }];
}
