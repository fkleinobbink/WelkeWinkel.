// Kruidvat (SAP Commerce / Spartacus). Productzoek-API via de browser (Akamai blokkeert gewone requests).
// Alleen eigen assortiment (geen marketplace: ligt niet in de winkel). Per categorie (niveau 2) pagineren,
// want één grote lijst geeft dubbelingen/gaten tussen pagina's.
const API = "https://api.kruidvat.nl/api/v2/kvn-spa";
const MEDIA = "https://media.kruidvat.nl";
const BASE_Q = ":name-asc:marketplaceProduct:false";

async function search(get, query, page, pageSize = 100) {
  const url = `${API}/search?fields=FULL&searchType=PRODUCT&query=${encodeURIComponent(query)}&pageSize=${pageSize}&currentPage=${page}&lang=nl&curr=EUR`;
  return JSON.parse((await get(url, { retries: 3, timeout: 60000, headers: { accept: "application/json" } })).text);
}

function map(p, tag) {
  const cats = (p.categoriesHierarchy?.[0]?.categories || []).map((c) => c.name);
  const img = (p.images || []).find((i) => i.format === "product") || (p.images || [])[0];
  const gtins = String(p.ean || "").split(",").filter(Boolean);
  return {
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
    page_url: tag,
  };
}

export async function* products({ get, log, deadline, max }) {
  const first = await search(get, BASE_Q, 0, 20);
  const total = first.pagination?.totalResults;
  const cats = (first.facets || []).find((f) => f.code === "categoryCodeLevel2")?.values || [];
  log(`kruidvat: ${total} producten in ${cats.length} categorieën`);
  const seen = new Set();
  let n = 0;
  for (const c of cats) {
    if (Date.now() > deadline || n >= max) break;
    const q = `${BASE_Q}:categoryCodeLevel2:${c.code}`;
    for (let page = 0, pages = 1; page < pages; page++) {
      let d;
      try { d = await search(get, q, page); } catch (e) { log(`kruidvat: ${c.name || c.code} p${page} mislukt: ${e.message}`); continue; }
      pages = d.pagination?.totalPages ?? 1;
      for (const p of d.products || []) {
        if (p.marketplaceProduct || String(p.code).startsWith("mp-") || seen.has(p.code)) continue;
        seen.add(p.code);
        yield map(p, `cat:${c.code}:${page}`);
        n++;
      }
    }
  }
  log(`kruidvat: ${n} unieke producten (van ${total})`);
}
