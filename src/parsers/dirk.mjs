// Dirk: JSON-LD zonder prijs; prijs staat in de HTML als <span class="price-large">1</span><span class="price-small">99</span>
// (zelfde opbouw als in de oude Loka-scraper).
import { extractProducts } from "../extract.mjs";

export function parse(html, url) {
  const { products } = extractProducts(html, url);
  if (!products.length) return [];
  const p = products[0];
  const large = html.match(/class="[^"]*price-large[^"]*"[^>]*>\s*(\d+)\s*</);
  const small = html.match(/class="[^"]*price-small[^"]*"[^>]*>\s*(\d+)\s*</);
  if (large) p.price = small ? parseFloat(`${large[1]}.${small[1]}`) : parseFloat(`0.${large[1]}`);
  p.currency = "EUR";
  return [p];
}
