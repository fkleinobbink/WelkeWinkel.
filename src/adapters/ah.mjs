// Albert Heijn via de (openbare) app-API: anoniem token -> zoeken per categorie (max 10.000 per zoekvraag).
const H = { "user-agent": "Appie/8.22.3", "x-application": "AHWEBSHOP", "content-type": "application/json", accept: "application/json" };

export async function* products({ get, log, deadline, max }) {
  const tok = JSON.parse((await get("https://api.ah.nl/mobile-auth/v1/auth/token/anonymous", { method: "POST", headers: H, body: JSON.stringify({ clientId: "appie" }) })).text);
  const A = { ...H, authorization: "Bearer " + tok.access_token };
  const cats = JSON.parse((await get("https://api.ah.nl/mobile-services/v1/product-shelves/categories", { headers: A })).text);
  log(`ah: ${cats.length} hoofdcategorieën`);
  const seen = new Set();
  let n = 0;
  const queue = cats.map((c) => ({ id: c.id, name: c.name }));
  while (queue.length && Date.now() < deadline && n < max) {
    const c = queue.shift();
    for (let page = 0; ; page++) {
      const url = `https://api.ah.nl/mobile-services/product/search/v2?page=${page}&size=1000&taxonomyId=${c.id}&sortOn=RELEVANCE`;
      let d;
      try { d = JSON.parse((await get(url, { headers: A, retries: 3, timeout: 60000 })).text); }
      catch (e) { log(`ah: ${c.name} p${page} mislukt ${e.message}`); break; }
      if (page === 0 && d.page.totalElements > 3000 && d.taxonomyNodes?.length && c.depth !== 3) {
        // te groot: subcategorieën apart
        for (const t of d.taxonomyNodes) queue.push({ id: t.id, name: `${c.name} > ${t.name}`, depth: (c.depth || 0) + 1 });
        log(`ah: ${c.name} te groot (${d.page.totalElements}), opgesplitst`);
        break;
      }
      for (const p of d.products || []) {
        if (seen.has(p.webshopId)) continue;
        seen.add(p.webshopId);
        const img = (p.images || []).find((i) => i.width === 400) || (p.images || [])[0];
        yield {
          name: p.title,
          brand: p.brand || null,
          price: p.currentPrice ?? p.priceBeforeBonus ?? null,
          regular_price: p.priceBeforeBonus ?? null,
          currency: "EUR",
          availability: p.orderAvailabilityStatus || null,
          sku: String(p.webshopId),
          hq_id: p.hqId,
          image_url: img?.url || null,
          category: p.subCategory || p.mainCategory || null,
          breadcrumb: [p.mainCategory, p.subCategory].filter(Boolean).join(" > ") || null,
          amount: p.salesUnitSize || null,
          promo: p.bonusMechanism || null,
          product_url: `https://www.ah.nl/producten/product/wi${p.webshopId}`,
          page_url: `cat:${c.id}:${page}`,
        };
        n++;
      }
      if (page + 1 >= d.page.totalPages) break;
    }
  }
  log(`ah: ${n} unieke producten`);
}
