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

function tag(block, name) {
  const a = block.indexOf(`<${name}>`);
  if (a < 0) return null;
  const b = block.indexOf(`</${name}>`, a);
  if (b < 0) return null;
  return decode(block.slice(a + name.length + 2, b));
}

// Zonder grote regexen (sitemaps kunnen 50MB zijn); limit = max aantal entries
export function parseSitemap(xml, limit = Infinity) {
  const head = xml.slice(0, 5000);
  const isIndex = /<(\w+:)?sitemapindex[\s>]/i.test(head);
  const open = isIndex ? "<sitemap" : "<url";
  const close = isIndex ? "</sitemap>" : "</url>";
  // namespace-prefix (bijv. <ns:url>) normaliseren
  if (!xml.includes(open + ">") && !xml.includes(open + " ") && /<\w+:(url|sitemap)[\s>]/.test(head + xml.slice(0, 20000))) {
    xml = xml.replace(/<(\/?)\w+:(urlset|url|loc|lastmod|sitemapindex|sitemap)\b/g, "<$1$2");
  }
  const entries = [];
  let pos = 0;
  while (entries.length < limit) {
    let a = xml.indexOf(open, pos);
    if (a < 0) break;
    const ch = xml[a + open.length];
    if (ch !== ">" && ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r") { pos = a + open.length; continue; }
    const b = xml.indexOf(close, a);
    if (b < 0) break;
    const block = xml.slice(a, b);
    pos = b + close.length;
    const loc = tag(block, "loc");
    if (!loc) continue;
    entries.push({ loc, lastmod: tag(block, "lastmod"), image: tag(block, "image:loc") });
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
    for (const e of entries) { try { e.loc = new URL(e.loc, sm).href; } catch {} } // relatieve URL's (bv. Praxis)
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
