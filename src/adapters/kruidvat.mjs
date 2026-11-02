// Kruidvat (SAP Commerce / Spartacus). Productzoek-API via de browser (Akamai blokkeert gewone requests).
// Alleen eigen assortiment (geen marketplace-producten: die liggen niet in de winkel).
const API = "https://api.kruidvat.nl/api/v2/kvn-spa";
const MEDIA = "https://media.kruidvat.nl";

export async function* products({ shop, get, log, deadline, max }) {
  const pageSize = 100;
  let page = 0, totalPages = 1, n = 0;
  while (page < totalPages && Date.now() < deadline && n < max) {
    const q = encodeURIComponent(":score:marketplaceProduct:false");
    const url = `${API}/search?fields=FULL&searchType=PRODUCT&query=${q}&pageSize=${pageSize}&currentPage=${page}&lang=nl&curr=EUR`;
    let data;
    try {
      data = JSON.parse((await get(url, { retries: 3, timeout: 60000, headers: { accept: "application/json" } })).text);
    } catch (e) {
      log(`kruidvat: pagina ${page} mislukt: ${e.message}`);
      page++;
      continue;
    }
    totalPages = data.pagination?.totalPages ?? totalPages;
    if (page === 0) log(`kruidvat: ${data.pagination?.totalResults} producten, ${totalPages} pagina's`);
    for (const p of data.products || []) {
      if (p.marketplaceProduct || String(p.code).startsWith("mp-")) continue;
      const cats = (p.categoriesHierarchy?.[0]?.categories || []).map((c) => c.name);
      const img = (p.images || []).find((i) => i.format === "product") || (p.images || [])[0];
      const gtins = String(p.ean || "").split(",").filter(Boolean);
      yield {
        name: p.name,
        brand: p.masterBrand?.name || p.masterBrand?.code?.replace(/^brand_/, "") || null,
        price: p.price?.value ?? null,
        currency: "EUR",
        availability: p.stock?.stockLevelStatus || null,
        gtin: gtins[0] || null,
        gtins: gtins.length > 1 ? gtins : undefined,
        sku: String(p.code),
        image_url: img ? MEDIA + img.url : null,
        category: cats.slice(-1)[0] || null,
        breadcrumb: cats.join(" > ") || null,
        amount: p.shortDescription || null,
        product_url: "https://www.kruidvat.nl" + p.url,
        page_url: `search:${page}`,
      };
      n++;
    }
    page++;
    if (page % 20 === 0) log(`kruidvat: pagina ${page}/${totalPages}, ${n} producten`);
  }
}
