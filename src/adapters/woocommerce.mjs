// Generiek voor WooCommerce-winkels: openbare Store API (/wp-json/wc/store/v1/products).
// config.storeAttribute: attribuut dat aangeeft in welk filiaal het item ligt (bv. RataPlan: "pa_rataplan-winkel").
import { decodeHtml } from "../extract.mjs";

const clean = (s) => (s == null ? null : decodeHtml(String(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null);

export async function* products({ shop, get, log, deadline, max }) {
  const base = shop.wcBase || `https://${shop.domain}`;
  let n = 0;
  for (let page = 1, pages = 1; page <= pages && Date.now() < deadline && n < max; page++) {
    const r = await get(`${base}/wp-json/wc/store/v1/products?per_page=100&page=${page}&orderby=id&order=asc`, { retries: 3, timeout: 60000, headers: { accept: "application/json" } });
    pages = parseInt(r.headers.get("x-wp-totalpages") || "1", 10);
    if (page === 1) log(`${shop.id}: ${r.headers.get("x-wp-total")} producten, ${pages} pagina's`);
    for (const p of JSON.parse(r.text)) {
      const minor = p.prices?.currency_minor_unit ?? 2;
      const price = p.prices?.price != null ? parseInt(p.prices.price, 10) / 10 ** minor : null;
      const cats = (p.categories || []).map((c) => clean(c.name)).filter((c) => c && !/niet gecategoriseerd/i.test(c));
      const storeAttr = shop.storeAttribute ? (p.attributes || []).find((a) => a.taxonomy === shop.storeAttribute) : null;
      const storeNames = (storeAttr?.terms || []).map((t) => clean(t.name));
      const tags = (p.tags || []).map((t) => clean(t.name));
      yield {
        name: clean(p.name),
        brand: (p.brands || []).map((b) => clean(b.name))[0] || null,
        price,
        currency: p.prices?.currency_code || "EUR",
        availability: p.is_in_stock ? "InStock" : "OutOfStock",
        sku: p.sku || String(p.id),
        image_url: p.images?.[0]?.src || null,
        category: cats.slice(-1)[0] || tags.filter((t) => !storeNames.includes(t))[0] || null,
        breadcrumb: cats.join(" > ") || null,
        description: clean(p.short_description)?.replace(/^Beschrijving\s*/i, "").slice(0, 500) || null,
        product_url: p.permalink,
        store_hint: storeNames[0] || null,
        page_url: `page:${page}`,
      };
      n++;
    }
  }
}
