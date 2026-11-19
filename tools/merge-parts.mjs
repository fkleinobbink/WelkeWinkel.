// Voegt de deel-bestanden van een gesplitste crawl samen:  <id>.part<k>.ndjson.gz -> <id>.ndjson.gz
//   node tools/merge-parts.mjs <map>      (print de samengevoegde winkel-id's)
// Ontbreekt een deel (job mislukt), dan blijft voor die URL's de vorige data van <id>.ndjson.gz staan.
import fs from "node:fs";
import zlib from "node:zlib";
import { shardOf } from "../src/shard.mjs";

const dir = process.argv[2] || "data";
const groups = new Map();
for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^(.+)\.part(\d+)\.ndjson\.gz$/);
  if (m) (groups.get(m[1]) || groups.set(m[1], []).get(m[1])).push(+m[2]);
}
const merged = [];
for (const [id, parts] of groups) {
  const reps = parts.map((k) => { try { return JSON.parse(fs.readFileSync(`${dir}/${id}.part${k}.report.json`)); } catch { return null; } });
  const of = Math.max(...reps.map((r) => r?.of || 0), ...parts.map((k) => k + 1));
  const lines = [];
  for (const k of parts) lines.push(...zlib.gunzipSync(fs.readFileSync(`${dir}/${id}.part${k}.ndjson.gz`)).toString("utf8").split("\n").filter(Boolean));
  const missing = [...Array(of).keys()].filter((k) => !parts.includes(k));
  if (missing.length && fs.existsSync(`${dir}/${id}.ndjson.gz`)) {
    for (const l of zlib.gunzipSync(fs.readFileSync(`${dir}/${id}.ndjson.gz`)).toString("utf8").split("\n")) {
      if (!l) continue;
      const p = JSON.parse(l);
      if (missing.includes(shardOf(p.page_url || p.product_url || "", of))) lines.push(l);
    }
  }
  fs.writeFileSync(`${dir}/${id}.ndjson.gz`, zlib.gzipSync(lines.join("\n") + "\n"));
  // rapporten optellen
  const r = { id, shards: of, missingShards: missing, errors: {} };
  for (const x of reps.filter(Boolean)) {
    for (const k of ["urls", "fetched", "reused", "kept", "blocked", "withPrice", "withGtin", "sitemapsOpened"]) r[k] = (r[k] || 0) + (x[k] || 0);
    for (const [k, v] of Object.entries(x.errors || {})) r.errors[k] = (r.errors[k] || 0) + v;
    r.minutes = Math.max(r.minutes || 0, x.minutes || 0);
    r.started ??= x.started; r.finished = x.finished;
    r.pagesPerMin = (r.pagesPerMin || 0) + (x.pagesPerMin || 0);
    r.sample ??= x.sample;
  }
  r.products = lines.length;
  fs.writeFileSync(`${dir}/${id}.report.json`, JSON.stringify(r, null, 1));
  for (const k of parts) for (const ext of ["ndjson.gz", "report.json"]) fs.rmSync(`${dir}/${id}.part${k}.${ext}`, { force: true });
  merged.push(id);
  console.error(`${id}: ${parts.length}/${of} delen, ${lines.length} producten`);
}
console.log(merged.join(" "));
