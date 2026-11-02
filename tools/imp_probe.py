# Test of TLS-impersonatie (curl_cffi) en/of echte browser blokkades omzeilt.
import sys, json, time
from curl_cffi import requests as cr
shops = json.load(open("config/shops.json"))
ids = sys.argv[1].split(",")
out = {}
for s in shops:
    if s["id"] not in ids: continue
    url = f"https://{s['domain']}/"
    res = {}
    for imp in ["chrome", "safari"]:
        try:
            r = cr.get(url, impersonate=imp, timeout=25, headers={"accept-language": "nl-NL,nl;q=0.9"})
            t = r.text
            res[imp] = [r.status_code, len(t), "captcha" in t.lower() or "challenge" in t.lower()]
            if r.status_code == 200:
                rb = cr.get(url + "robots.txt", impersonate=imp, timeout=25)
                res[imp + "_robots"] = [rb.status_code, [l for l in rb.text.splitlines() if l.lower().startswith("sitemap")][:6]]
                break
        except Exception as e:
            res[imp] = str(e)[:100]
    out[s["id"]] = res
    print(s["id"], json.dumps(res)[:400], flush=True)
json.dump(out, open("probe-out/imp.json", "w"), indent=1)
