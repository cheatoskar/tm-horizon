#!/usr/bin/env python3
"""Re-runnable link checker for catalog.json.
Plain GET, generic user agent, no cookies. Writes status/checked back to catalog.json
and details (HTTP code, final URL, errors, Discord invite names) to checks.json.
Usage: PYTHONIOENCODING=utf-8 python check_links.py [--only id1,id2]
"""
import json, os, re, sys, time, datetime, subprocess, urllib.request, urllib.error, urllib.parse, socket
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "Mozilla/5.0 (compatible; link-check/1.0)"
TODAY = datetime.date.today().isoformat()
DISCORD = re.compile(r"^https?://(?:discord\.gg|discordapp\.com/invite|discord\.com/invite)/([A-Za-z0-9-]+)")

def curl(url, timeout=25):
    """Second opinion with curl (own CA bundle; Python on this machine rejects some chains)."""
    try:
        out = subprocess.run(["curl", "-sL", "-o", os.devnull, "-A", UA, "--max-time", str(timeout),
                              "-w", "%{http_code} %{url_effective}", url],
                             capture_output=True, text=True, timeout=timeout + 10)
        code, _, final = out.stdout.strip().partition(" ")
        if code.isdigit() and int(code) > 0:
            return {"code": int(code), "final": final, "via": "curl"}
        return {"code": None, "error": "curl exit %s" % out.returncode, "via": "curl"}
    except Exception as ex:
        return {"code": None, "error": "curl: " + str(ex)[:100], "via": "curl"}

def get(url, timeout=25):
    res = _get(url, timeout)
    if res.get("code") is None or res.get("code") in (403, 429):
        res2 = curl(url, timeout)
        if res2.get("code") is not None:
            return res2
    return res

def _get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(2048)
            return {"code": r.status, "final": r.geturl()}
    except urllib.error.HTTPError as ex:
        return {"code": ex.code, "final": ex.geturl()}
    except Exception as ex:
        return {"code": None, "error": type(ex).__name__ + ": " + str(ex)[:120]}

def dns_resolves(host):
    """True if the host resolves through a public resolver (8.8.8.8)."""
    try:
        o = subprocess.run(["nslookup", host, "8.8.8.8"], capture_output=True, text=True, timeout=20).stdout
        return "Name:" in o and "Addresses:" in o or ("Name:" in o and o.count("Address:") >= 2)
    except Exception:
        return False

def classify(res, url=None):
    c = res.get("code")
    if c is None:
        err = res.get("error", "")
        if "getaddrinfo" in err or "Name or service" in err:
            host = urllib.parse.urlparse(url).hostname if url else None
            return "unclear" if host and dns_resolves(host) else "dead"
        if "refused" in err.lower():
            return "dead"
        return "unclear"   # timeouts, TLS problems
    if 200 <= c < 300:
        return "alive"
    if 300 <= c < 400:
        return "unclear"
    if c in (404, 410):
        return "dead"
    return "unclear"      # 403/429/5xx etc: blocked or flaky, cannot tell

def wayback(url):
    q = "https://archive.org/wayback/available?url=" + urllib.parse.quote(url, safe="")
    try:
        req = urllib.request.Request(q, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.load(r)
        snap = d.get("archived_snapshots", {}).get("closest")
        return snap["url"] if snap and snap.get("available") else None
    except Exception:
        return None

def check(entry):
    url = entry["url"]
    if not url:   # file only exists as a Discord attachment (signed, expiring link)
        return entry["id"], {"status": "unclear", "res": {"code": None, "error": "no public URL (Discord attachment only)"}}
    m = DISCORD.match(url)
    if m:
        res = get("https://discord.com/api/v9/invites/%s?with_counts=true" % m.group(1))
        info = {}
        if res.get("code") == 200:
            try:
                o = subprocess.run(["curl", "-s", "-A", UA, "--max-time", "25",
                                    "https://discord.com/api/v9/invites/%s?with_counts=true" % m.group(1)],
                                   capture_output=True, text=True, timeout=40)
                d = json.loads(o.stdout)
                info = {"guild": d.get("guild", {}).get("name"), "members": d.get("approximate_member_count")}
            except Exception:
                pass
        res["invite"] = info
        time.sleep(2.5)
    elif "speedrun.com/" in url and "/api/" not in url:
        # speedrun.com blocks plain page GETs (403); the public API answers for the same game
        res = get("https://www.speedrun.com/api/v1/games/" + url.rstrip("/").rsplit("/", 1)[1])
        res["via_api"] = True
    else:
        res = get(url)
    st = classify(res, url)
    out = {"status": st, "res": res}
    mirrors = {}
    for mu in entry.get("urls", []):
        if mu.startswith("https://discord") or "dotnet" in mu:
            continue
        mres = get(mu)
        mirrors[mu] = {"code": mres.get("code"), "final": mres.get("final"), "error": mres.get("error")}
    if mirrors:
        out["mirrors"] = mirrors
        if st == "dead" and any((v["code"] or 0) // 100 == 2 for v in mirrors.values()):
            out["status"] = "unclear"
            out["note"] = "Primary URL is dead (%s); at least one mirror answers 200." % res.get("code")
    if st == "dead":
        out["archive"] = wayback(url)
    return entry["id"], out

def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    path = os.path.join(HERE, "catalog.json")
    cat = json.load(open(path, encoding="utf-8"))
    todo = [e for e in cat["entries"] if not only or e["id"] in only]
    with ThreadPoolExecutor(6) as ex:
        results = dict(ex.map(check, todo))
    detail_path = os.path.join(HERE, "checks.json")
    details = json.load(open(detail_path, encoding="utf-8")) if os.path.exists(detail_path) and only else {}
    for e in cat["entries"]:
        r = results.get(e["id"])
        if not r:
            continue
        e["status"] = r["status"]
        e["checked"] = TODAY
        if r.get("archive"):
            e["archive"] = r["archive"]
        details[e["id"]] = r
        if r.get("note"):
            e["note"] = ((e.get("note") or "") + " " + r["note"]).strip()
    for e in cat["entries"]:
        inv = details.get(e["id"], {}).get("res", {}).get("invite") or {}
        if inv.get("guild"):
            e["name"] = inv["guild"].replace("  ", " ").strip() + " (Discord)"
            e["description"] = "Discord server, about %s members when checked; invite link from awesome-trackmania." % inv.get("members")
    cat["updated"] = TODAY
    json.dump(cat, open(path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    json.dump(details, open(detail_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    from collections import Counter
    print(Counter(r["status"] for r in results.values()))
    for i, r in sorted(results.items()):
        if r["status"] != "alive":
            print(i, r["status"], r["res"].get("code"), r["res"].get("error", ""), r["res"].get("final", ""))

if __name__ == "__main__":
    main()
