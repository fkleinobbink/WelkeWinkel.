// Søstrene Grene: alles client-side, maar de pagina bevat window.vertica = { pageData: {...} } met de productgegevens.
function pageData(html) {
  const i = html.indexOf("pageData:");
  if (i < 0) return null;
  const t = html.slice(i + 9);
  let d = 0, start = t.indexOf("{");
  for (let j = start; j < t.length; j++) {
    if (t[j] === "{") d++;
    else if (t[j] === "}" && --d === 0) { try { return JSON.parse(t.slice(start, j + 1)); } catch { return null; } }
  }
  return null;
}

export function parse(html, url) {
  const pd = pageData(html);
  const det = pd?.jsonContent?.content?.details;
  if (!det?.name) return [];
  const crumbs = (pd.navigation?.breadcrumb || []).map((b) => b.name).slice(2);
  const vs = det.variants || [];
  const prices = vs.map((v) => v.pricing?.unit?.amount).filter((x) => typeof x === "number");
  const img = (html.match(/<link rel="preload" as="image"\s+href="([^"]+)"/) || [])[1];
  return [{
    name: det.subtitle ? `${det.name} (${det.subtitle.replace(/\.$/, "")})` : det.name,
    brand: det.brand || "Søstrene Grene",
    price: prices.length ? Math.min(...prices) : null,
    currency: "EUR",
    availability: vs.some((v) => (v.inventory?.inStock || 0) > 0) ? "InStock" : "OutOfStock",
    sku: vs[0]?.sku || det.id,
    variants: vs.length > 1 ? vs.length : undefined,
    image_url: img || null,
    description: det.description ? String(det.description).replace(/<[^>]+>/g, " ").slice(0, 500) : null,
    category: crumbs.slice(-1)[0] || null,
    breadcrumb: crumbs.join(" > ") || null,
    product_url: url,
  }];
}
