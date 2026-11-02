// robots.txt + sitemaps (ook sitemap-indexen en .gz) uitlezen.
import { get } from "./http.mjs";

export async function robotsSitemaps(origin) {
  try {
    const r = await get(`${origin}/robots.txt`, { retries: 1 });
    const maps = [...r.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1].trim());
    return { text: r.text, sitemaps: [...new Set(maps)] };
  } catch (e) {
    return { text: "", sitemaps: [], error: String(e) };
  }
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

export function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const blocks = xml.split(isIndex ? /<sitemap[\s>]/i : /<url[\s>]/i).slice(1);
  const entries = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>([\s\S]*?)<\/loc>/i);
    if (!loc) continue;
    const lastmod = b.match(/<lastmod>([\s\S]*?)<\/lastmod>/i);
    const img = b.match(/<image:loc>([\s\S]*?)<\/image:loc>/i);
    entries.push({ loc: decode(loc[1]), lastmod: lastmod ? decode(lastmod[1]) : null, image: img ? decode(img[1]) : null });
  }
  return { isIndex, entries };
}

// Loopt recursief door sitemaps. filter(subSitemapUrl) bepaalt welke sub-sitemaps we openen.
export async function walkSitemaps(roots, { sitemapFilter = () => true, urlFilter = () => true, maxSitemaps = 2000, maxUrls = Infinity, log = () => {} } = {}) {
  const seen = new Set();
  const queue = [...roots];
  const urls = [];
  let opened = 0;
  while (queue.length && opened < maxSitemaps && urls.length < maxUrls) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml;
    try {
      xml = (await get(sm, { retries: 2, timeout: 60000 })).text;
      opened++;
    } catch (e) {
      log(`sitemap fail ${sm}: ${e.message}`);
      continue;
    }
    const { isIndex, entries } = parseSitemap(xml);
    if (isIndex) {
      for (const e of entries) if (sitemapFilter(e.loc)) queue.push(e.loc);
    } else {
      for (const e of entries) {
        if (urlFilter(e.loc)) urls.push({ ...e, sitemap: sm });
        if (urls.length >= maxUrls) break;
      }
    }
  }
  return { urls, opened, sitemapsSeen: [...seen] };
}
