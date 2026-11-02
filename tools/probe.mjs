// Probe: haalt een lijst URL's op en schrijft status/headers/body weg,
// zodat we vanuit Actions kunnen zien hoe een winkelsite eruitziet.
// Input: probe/jobs.json  -> [{ "name": "...", "url": "...", "method": "GET", "headers": {}, "body": "...", "max": 200000 }]
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const jobs = JSON.parse(fs.readFileSync(process.argv[2] || "probe/jobs.json", "utf8"));
const outDir = process.argv[3] || "probe-out";
fs.mkdirSync(outDir, { recursive: true });

const slug = (s) => s.replace(/[^a-z0-9]+/gi, "_").slice(0, 80);

async function run(job, i) {
  const name = job.name || `${i}_${slug(job.url)}`;
  const started = Date.now();
  try {
    const res = await fetch(job.url, {
      method: job.method || "GET",
      headers: { "user-agent": UA, "accept-language": "nl-NL,nl;q=0.9", accept: "*/*", ...(job.headers || {}) },
      body: job.body,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString("utf8");
    const max = job.max || 150000;
    const meta = {
      url: job.url,
      finalUrl: res.url,
      status: res.status,
      ms: Date.now() - started,
      bytes: buf.length,
      headers: Object.fromEntries(res.headers),
    };
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(outDir, `${name}.body`), text.slice(0, max));
    return `${res.status} ${buf.length}B ${name}`;
  } catch (e) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ url: job.url, error: String(e) }, null, 2));
    return `ERR ${name} ${e}`;
  }
}

const lines = [];
const queue = jobs.map((j, i) => [j, i]);
const workers = Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const [j, i] = queue.shift();
    lines.push(await run(j, i));
  }
});
await Promise.all(workers);
fs.writeFileSync(path.join(outDir, "_index.txt"), lines.sort().join("\n") + "\n");
console.log(lines.join("\n"));
