// Haalt URL's op via de browser-engine (in-page fetch na het openen van de homepage).
//   node tools/bget.mjs <out-dir> '<json: [{"name":"x","url":"..."}]>'
import fs from "node:fs";
import { get, setEngine, closeBrowser } from "../src/http.mjs";
setEngine(process.env.ENGINE_TYPE || "browser", process.env.IMP || "chrome");
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const jobs = JSON.parse(process.argv[3]);
const idx = [];
for (const j of jobs) {
  try {
    const r = await get(j.url, { retries: 1, timeout: 45000, headers: j.headers || {}, method: j.method || "GET", body: j.body });
    fs.writeFileSync(`${out}/${j.name}.body`, r.text);
    idx.push(`${r.status} ${r.text.length}B ${j.name} ${j.url.slice(0, 150)}`);
  } catch (e) {
    fs.writeFileSync(`${out}/${j.name}.body`, String(e.body || e));
    idx.push(`ERR ${e.status || ""} ${j.name} ${String(e.message).slice(0, 150)}`);
  }
}
await closeBrowser();
fs.writeFileSync(`${out}/_index.txt`, idx.join("\n") + "\n");
console.log(idx.join("\n"));
