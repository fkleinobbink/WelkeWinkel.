// ALDI: productdata zit in __NEXT_DATA__ -> props.pageProps.apiData (PRODUCT_DETAIL_GET)
import { nextData } from "../extract.mjs";

export function parse(html, url) {
  const nd = nextData(html);
  let api = nd?.props?.pageProps?.apiData;
  if (typeof api === "string") { try { api = JSON.parse(api); } catch { return []; } }
  if (!Array.isArray(api)) return [];
  const entry = api.find((e) => e[0] === "PRODUCT_DETAIL_GET");
  const res = entry?.[1]?.res;
  const p = res?.products?.[0];
  if (!p) return [];
  const cat = res.parentCategory?.data;
  const img = (p.assets || []).find((a) => a.type === "primary");
  return [{
    name: p.name,
    brand: p.brandName || null,
    price: p.currentPrice?.priceValue ?? null,
    currency: "EUR",
    availability: p.isAvailable ? "InStock" : "OutOfStock",
    sku: p.objectID,
    image_url: img?.url || null,
    category: cat?.current?.categoryName || p.mainCategoryID || null,
    breadcrumb: [cat?.parent?.categoryName, cat?.current?.categoryName].filter(Boolean).join(" > ") || null,
    amount: p.salesUnit || null,
    description: p.shortDescription || null,
    product_url: url,
  }];
}
