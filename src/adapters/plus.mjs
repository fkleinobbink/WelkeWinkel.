// PLUS (OutSystems). De website haalt productlijsten op via 'screenservices'; wij sturen hetzelfde verzoek.
// Templates van de request-body staan in src/adapters/data/ (bij 'hasApiVersionChanged' opnieuw vastleggen met tools/netlog.mjs).
import fs from "node:fs";
const BASE = "https://www.plus.nl/screenservices";
const H = { "content-type": "application/json; charset=UTF-8", "x-csrftoken": "T6C+9iB49TLra4jEsMeSckDMNhQ=", "outsystems-locale": "nl-NL", accept: "application/json" };
const tpl = (f) => JSON.parse(fs.readFileSync(new URL(`./data/${f}`, import.meta.url), "utf8"));

export async function* products({ get, log, deadline, max }) {
  const menuBody = tpl("plus_menu_body.json");
  const menu = JSON.parse((await get(`${BASE}/ECP_Product_CW/Categories/CategoryList_TF/DataActionGetMenuCategories`, { method: "POST", headers: H, body: JSON.stringify(menuBody) })).text);
  if (menu.versionInfo?.hasApiVersionChanged) log("plus: LET OP api-versie gewijzigd, templates verversen");
  const cats = JSON.parse(menu.data.CategoriesJson).map((c) => c.Category_str);
  const top = cats.filter((c) => !c.ParentExternalId && c.ExternalId && c.Slug !== "promotions");
  log(`plus: ${top.length} hoofdcategorieën`);
  const seen = new Set();
  let n = 0;
  for (const c of top) {
    for (let page = 1, pages = 1; page <= pages && Date.now() < deadline && n < max; page++) {
      const body = tpl("plus_plp_body.json");
      Object.assign(body.screenData.variables, { CategorySlug: c.Slug, PageNumber: page });
      let d;
      try {
        d = JSON.parse((await get(`${BASE}/ECP_Composition_CW/ProductLists/PLP_Content/DataActionGetProductListAndCategoryInfo`, { method: "POST", headers: H, body: JSON.stringify(body), retries: 3 })).text).data;
      } catch (e) { log(`plus: ${c.Slug} p${page} mislukt ${e.message}`); continue; }
      pages = d.TotalPages || 1;
      if (page === 1) log(`plus: ${c.Name}: ${d.TotalNumberItems} producten`);
      for (const it of d.ProductList?.List || []) {
        const p = it.PLP_Str;
        if (!p?.SKU || seen.has(p.SKU)) continue;
        seen.add(p.SKU);
        const cats = (p.Categories?.List || []).map((x) => x.Name);
        const np = parseFloat(p.NewPrice), op = parseFloat(p.OriginalPrice);
        yield {
          name: p.Name,
          brand: p.Brand || null,
          price: np > 0 ? np : Number.isFinite(op) ? op : null,
          regular_price: Number.isFinite(op) ? op : null,
          currency: "EUR",
          availability: p.IsAvailable ? "InStock" : "OutOfStock",
          gtin: p.EAN || null,
          sku: p.SKU,
          image_url: p.ImageURL || null,
          category: cats.slice(-1)[0] || null,
          breadcrumb: cats.join(" > ") || null,
          amount: (p.Product_Subtitle || "").replace(/^Per\s+/i, "") || null,
          promo: p.PromotionLabel || null,
          product_url: `https://www.plus.nl/product/${p.Slug}`,
          page_url: `cat:${c.Slug}:${page}`,
        };
        n++;
      }
    }
  }
  log(`plus: ${n} unieke producten`);
}
