"""Smoke test against a FAKE Supabase (no network, no real data): email-code sign-in, first-sign-in seeding of Art's list,
ticks saved with who + owner, schema-missing message, offline cache key.
usage: (python3 -m http.server 8766 &) ; /workspace/.venv-pw/bin/python tests/smoke_supabase.py [base_url]"""
import sys, json, time, base64, re
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8766/"
FAKE = "https://fakeproj.supabase.co"
UID, EMAIL = "00000000-0000-0000-0000-0000000000aa", "derek@example.com"
CONFIG = f"window.ART_CONFIG={{backend:'supabase',supabaseUrl:'{FAKE}',supabaseAnonKey:'anon-test-key'}};"
results = []
def ok(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
def jwt():
    now = int(time.time()); return f"{b64({'alg':'HS256','typ':'JWT'})}.{b64({'sub':UID,'email':EMAIL,'role':'authenticated','aud':'authenticated','exp':now+3600,'iat':now})}.c2ln"
USER = {"id": UID, "email": EMAIL, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-10-01T00:00:00Z"}
state = {"schema": False, "n": 0}
DB = {"art_items": [], "art_ticks": [], "art_health": [], "art_supplies": []}
def fake(route):
    req = route.request; path = req.url.split(FAKE, 1)[1]
    hdr = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*", "Content-Type": "application/json"}
    if req.method == "OPTIONS": return route.fulfill(status=200, headers=hdr, body="")
    if path.startswith("/auth/v1/otp"): return route.fulfill(status=200, headers=hdr, body="{}")
    if path.startswith("/auth/v1/verify"):
        if json.loads(req.post_data or "{}").get("token") != "123456": return route.fulfill(status=403, headers=hdr, body=json.dumps({"code": 403, "error_code": "otp_expired", "msg": "Token has expired or is invalid"}))
        return route.fulfill(status=200, headers=hdr, body=json.dumps({"access_token": jwt(), "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": "rt", "user": USER}))
    if path.startswith("/auth/v1/user"): return route.fulfill(status=200, headers=hdr, body=json.dumps(USER))
    if path.startswith("/auth/v1/token"): return route.fulfill(status=200, headers=hdr, body=json.dumps({"access_token": jwt(), "token_type": "bearer", "expires_in": 3600, "refresh_token": "rt2", "user": USER}))
    m = re.match(r"/rest/v1/(\w+)", path)
    if not m: return route.fulfill(status=404, headers=hdr, body="{}")
    t = m.group(1)
    if not state["schema"]: return route.fulfill(status=404, headers=hdr, body=json.dumps({"code": "PGRST205", "message": f"Could not find the table 'public.{t}' in the schema cache"}))
    rows = DB[t]; q = parse_qs(urlparse(req.url).query)
    flt = {k: v[0][3:] for k, v in q.items() if v[0].startswith("eq.")}
    sel = [r for r in rows if all(str(r.get(k)) == v for k, v in flt.items())]
    single = "vnd.pgrst.object" in (req.headers.get("accept") or "")
    if req.method in ("GET", "HEAD"):
        h = dict(hdr, **{"Content-Range": f"0-{max(0, len(sel)-1)}/{len(sel)}"})
        return route.fulfill(status=200, headers=h, body="" if req.method == "HEAD" else json.dumps(sel))
    if req.method == "POST":
        new = json.loads(req.post_data); new = new if isinstance(new, list) else [new]
        out = []
        for r in new:
            assert r.get("owner_id") == UID, "owner_id missing"
            if t in ("art_items", "art_supplies") and any(x["name"] == r["name"] for x in rows): continue   # ignoreDuplicates
            state["n"] += 1; r = dict({"id": f"{t}-{state['n']}", "created_at": "2026-10-24T08:12:00Z"}, **r); rows.append(r); out.append(r)
        return route.fulfill(status=201, headers=hdr, body=json.dumps(out[0] if single else out))
    if req.method == "PATCH":
        for r in sel: r.update(json.loads(req.post_data))
        return route.fulfill(status=200, headers=hdr, body=json.dumps(sel[0] if single and sel else sel))
    if req.method == "DELETE":
        DB[t] = [r for r in rows if r not in sel]; return route.fulfill(status=204, headers=hdr, body="")
    return route.fulfill(status=405, headers=hdr, body="{}")

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
    ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="en-IE", service_workers="block")
    ctx.route("**/config.js*", lambda r: r.fulfill(status=200, content_type="application/javascript", body=CONFIG))
    ctx.route(FAKE + "/**", fake); ctx.route("wss://fakeproj.supabase.co/**", lambda r: r.abort())
    pg = ctx.new_page(); errors = []
    pg.on("pageerror", lambda e: errors.append(str(e))); pg.on("dialog", lambda d: d.accept())
    pg.goto(BASE + "?today=2026-10-24"); pg.wait_for_selector("#login")
    ok("sign-in screen mentions Chores login", "same email as the Chores app" in pg.inner_text("#view"))
    pg.fill("#email", EMAIL); pg.click("#login button"); pg.wait_for_selector("#code")
    pg.screenshot(path="screenshots/signin.png")
    pg.fill("#code", "000000"); pg.click("#code-form button"); pg.wait_for_selector(".login .err")
    ok("wrong code message", "wrong or has expired" in pg.inner_text(".login .err"))
    pg.fill("#code", "123456"); pg.click("#code-form button"); pg.wait_for_selector(".conn-card, .banner.conn", timeout=15000)
    ok("tables missing: clear SQL Editor message", "aren't set up yet" in pg.inner_text("#view") and "schema.sql" in pg.inner_text("#view"))
    state["schema"] = True
    pg.click("[data-retry]"); pg.wait_for_selector(".progress", timeout=15000)
    ok("first sign-in seeds Art's list", len(DB["art_items"]) == 9 and len(DB["art_supplies"]) == 4 and len(DB["art_health"]) == 1)
    ok("seeded rows belong to the user", all(r["owner_id"] == UID for r in DB["art_items"] + DB["art_health"]))
    ok("today shows due treatments", "Worming tablet" in pg.inner_text("#view") and "0 of 4 done today" in pg.inner_text("#view"))
    pg.click("[data-who=Peter]")
    pg.locator(".item[data-id]", has_text="Worming").locator(".tick").tap(); pg.wait_for_selector("#toast:not([hidden])")
    tk = DB["art_ticks"][0] if DB["art_ticks"] else {}
    ok("tick saved with who + cleared due date", tk.get("who") == "Peter" and tk.get("done_on") == "2026-10-24" and tk.get("cleared_due") == "2026-10-24")
    ok("item due date used up", next(i for i in DB["art_items"] if i["name"] == "Worming tablet")["due_date"] is None)
    pg.click("#undo"); pg.wait_for_timeout(500)
    ok("undo deletes tick + restores due date", not DB["art_ticks"] and next(i for i in DB["art_items"] if i["name"] == "Worming tablet")["due_date"] == "2026-10-24")
    ok("data cached on device", pg.evaluate(f"!!localStorage.getItem('art.cache.v1.{UID}')"))
    pg.reload(); pg.wait_for_selector(".progress", timeout=15000)
    ok("reload does not seed twice", len(DB["art_items"]) == 9 and len(DB["art_health"]) == 1)
    ok("no page errors", not errors)
    if errors: print(errors)
    br.close()
fails = [n for n, c in results if not c]
print(f"{len(results) - len(fails)}/{len(results)} passed"); sys.exit(1 if fails else 0)
