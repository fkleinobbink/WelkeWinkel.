// Jeans Centre: productgegevens in __NEXT_DATA__ (page.productDetailInfo); prijs wordt client-side geladen.
import { nextData } from "../extract.mjs";

export function parse(html, url) {
  const p = nextData(html)?.props?.pageProps?.page?.productDetailInfo;
  if (!p?.name || p.onlineOnly) return [];
  const img = p.desktopImages?.[0];
  const cats = String(p.productCategoryPath || "").split(/[>/|]/).map((x) => x.trim()).filter(Boolean);
  return [{
    name: (p.name.toLowerCase().startsWith(String(p.brand?.brandId || "").toLowerCase()) ? p.name : [p.brand?.brandId, p.name].filter(Boolean).join(" ")).replace(/\b\w/g, (c) => c.toUpperCase()),
    brand: p.brand?.brandId || null,
    color: typeof p.color === "string" ? p.color : p.color?.name || null,
    price: null,
    sku: p.ctpId || p.gtmId || null,
    image_url: img?.lowest || img?.url || null,
    category: cats.slice(-1)[0] || null,
    breadcrumb: cats.join(" > ") || null,
    product_url: url,
  }];
}
