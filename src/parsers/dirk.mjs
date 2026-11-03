// Dirk en DekaMarkt (zelfde platform, Detailresult): naam/merk uit JSON-LD, prijs uit de Nuxt-payload
// (normalPrice/offerPrice). Oude fallback: <span class="price-large">..</span><span class="price-small">..</span>.
import { extractProducts, nuxtFind } from "../extract.mjs";

export function parse(html, url) {
  const { products } = extractProducts(html, url);
  if (!products.length) return [];
  const p = products[0];
  const pr = nuxtFind(html, ["normalPrice", "offerPrice", "productId"]);
  if (pr && typeof pr.normalPrice === "number") {
    p.price = pr.offerPrice > 0 ? pr.offerPrice : pr.normalPrice;
    p.regular_price = pr.normalPrice;
    if (pr.offerPrice > 0) p.promo_until = pr.endDate || null;
  } else {
    const large = html.match(/class="[^"]*price-large[^"]*"[^>]*>\s*(\d+)\s*</);
    const small = html.match(/class="[^"]*price-small[^"]*"[^>]*>\s*(\d+)\s*</);
    if (large) p.price = small ? parseFloat(`${large[1]}.${small[1]}`) : parseFloat(`0.${large[1]}`);
  }
  if (p.image_url) p.image_url = p.image_url.replace(/(\.nl)(artikelen\/)/, "$1/$2");
  p.currency = "EUR";
  return [p];
}
