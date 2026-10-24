"""UI smoke test against the local mock + phone screenshots.
usage: (python3 -m http.server 8766 &) ; /workspace/.venv-pw/bin/python tests/smoke_ui.py [base_url]"""
import sys, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8766/"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "screenshots")
errors, results = [], []
def ok(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="en-IE", service_workers="block")
    ctx.route("**/config.js*", lambda r: r.fulfill(status=200, content_type="application/javascript",
        body="window.ART_CONFIG={backend:'mock',dog:{name:'Art',about:'White-and-black lurcher · born June 2020'},vet:{name:'Dublin Bay Vets',address:'5 Main Street, Clongriffin, Dublin 13',phone:'01 539 2330',tel:'+35315392330'}};"))
    pg = ctx.new_page()
    row = lambda n: pg.locator(".item[data-id]").filter(has=pg.get_by_text(n, exact=True))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text)); pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.goto(BASE + "?today=2026-10-24"); pg.wait_for_selector(".progress")
    ok("header date", "Saturday 24/10/2026" in pg.inner_text("#today"))
    txt = pg.inner_text("#view")
    ok("four daily items", all(x in txt for x in ["Morning walk", "Evening walk", "Breakfast", "Dinner"]))
    ok("due list has worming/flea/wash/teeth", all(x in txt for x in ["Worming tablet", "Flea tablet", "Wash", "Teeth cleaning at vet"]))
    ok("vaccine not in due", "Vaccine booster" not in txt)
    ok("Today due grouped by category", [h.inner_text().strip().lower() for h in pg.locator("h3.sub-sec").all()] == ["treatments", "grooming", "vet & health", "home & admin", "seasonal"])
    pg.screenshot(path=f"{OUT}/today.png", full_page=True)
    # who + tick daily
    pg.click("[data-who=Derek]")
    pg.locator(".item[data-id]", has_text="Morning walk").locator(".tick").tap(); pg.wait_for_selector("#toast:not([hidden])")
    ok("tick toast says Derek", "(Derek)" in pg.inner_text("#toast"))
    ok("progress 1 of 4", "1 of 5" in pg.inner_text(".progress"))
    ok("who chip on row", "Derek" in pg.locator(".item[data-id]", has_text="Morning walk").inner_text())
    # untick by tapping again, then undo the untick
    pg.locator(".item[data-id]", has_text="Morning walk").locator(".tick").tap(); pg.wait_for_timeout(300)
    ok("untick", "0 of 5" in pg.inner_text(".progress") and "unticked" in pg.inner_text("#toast"))
    pg.click("#undo"); pg.wait_for_timeout(300)
    ok("undo untick", "1 of 5" in pg.inner_text(".progress"))
    # treatment tick -> next due + undo
    pg.locator(".item[data-id]", has_text="Flea tablet").first.locator(".tick").tap(); pg.wait_for_selector("#toast:not([hidden])")
    ok("flea toast next due", "next Tue 24/11/2026" in pg.inner_text("#toast"))
    pg.screenshot(path=f"{OUT}/ticked.png", full_page=True)
    pg.click("#undo"); pg.wait_for_timeout(300)
    ok("undo flea -> due again", "due today" in pg.locator(".item[data-id]", has_text="Flea tablet").first.inner_text())
    # long-press = pick a date
    it = row("Wash").first.locator(".body"); it.evaluate("e => e.scrollIntoView({block: 'center'})"); box = it.bounding_box()
    pg.mouse.move(box["x"] + 20, box["y"] + 10); pg.mouse.down(); pg.wait_for_timeout(800); pg.mouse.up(); pg.wait_for_timeout(150)
    ok("long-press opens date sheet", pg.locator("#sheet[open]").count() == 1)
    pg.fill("#sheet-date", "2026-10-20"); pg.click("#sheet-ok"); pg.wait_for_timeout(300)
    ok("picked date toast", "done Tue 20/10/2026" in pg.inner_text("#toast") and "next Fri 20/11/2026" in pg.inner_text("#toast"))
    # care tab + item sheet + history
    pg.click("[data-tab=care]"); pg.wait_for_timeout(200)
    ok("care shows vaccine 15/08/2027", "Sun 15/08/2027" in pg.inner_text("#view"))
    heads = [h.inner_text().split("\n")[0].strip() for h in pg.locator("#view h2.sec").all()]
    ok("care sections in order", heads == ["Daily", "Treatments", "Grooming", "Vet & health", "Home & admin", "Seasonal"]); print(heads)
    pg.screenshot(path=f"{OUT}/care.png", full_page=True)
    row("Wash").locator(".name").click(); pg.wait_for_selector("#item-sheet[open]")
    ok("item sheet history shows 20/10 by Derek", "Tue 20/10/2026" in pg.inner_text("#item-sheet") and "Derek" in pg.inner_text("#item-sheet"))
    pg.screenshot(path=f"{OUT}/item_sheet.png")
    pg.click("#item-sheet [data-rmtick]"); pg.wait_for_timeout(300)
    ok("remove tick puts due date back", "due today" in row("Wash").inner_text())
    # edit: book teeth cleaning + notes
    row("Teeth cleaning at vet").locator(".name").click(); pg.wait_for_selector("#item-sheet[open]")
    pg.click("#is-edit"); pg.wait_for_selector("#edit-sheet[open]")
    pg.fill("#edit-form [name=due_date]", "2026-11-03"); pg.fill("#edit-form [name=notes]", "Booked 03/11 09:30"); pg.click("#edit-form button.primary"); pg.wait_for_timeout(300)
    ok("teeth booked -> due date shown", "due in 10 days" in row("Teeth cleaning at vet").inner_text())
    # add + retire item
    pg.click("[data-add]"); pg.wait_for_selector("#edit-sheet[open]")
    pg.fill("#edit-form [name=name]", "Toy wash"); pg.select_option("#edit-form [name=frequency]", "Every 2 months"); pg.fill("#edit-form [name=last_done]", "2026-10-01")
    pg.click("#edit-form button.primary"); pg.wait_for_timeout(300)
    ok("added toy wash due 01/12", "Toy wash" in pg.inner_text("#view") and "due Tue 01/12/2026" in pg.locator(".item[data-id]", has_text="Toy wash").inner_text())
    pg.locator(".item[data-id]", has_text="Toy wash").locator(".name").click(); pg.click("#is-edit"); pg.wait_for_selector("#edit-sheet[open]")
    pg.uncheck("#edit-form [name=active]"); pg.click("#edit-form button.primary"); pg.wait_for_timeout(300)
    ok("retired", pg.locator("details.retired").count() == 1 and pg.locator(".item[data-id]", has_text="Toy wash").count() == 0)
    # health
    pg.click("[data-tab=health]"); pg.wait_for_timeout(200)
    ok("seed health entry", "Weight about 20 kg" in pg.inner_text("#view") and "20 kg" in pg.inner_text(".weight-card"))
    pg.click("#add-health summary"); pg.fill("#health-form [name=text]", "Vet check – all fine"); pg.fill("#health-form [name=weight_kg]", "20.4"); pg.click("#health-form button.primary"); pg.wait_for_timeout(300)
    ok("health entry added + latest weight", "Vet check" in pg.inner_text("#view") and "20.4 kg" in pg.inner_text(".weight-card"))
    pg.screenshot(path=f"{OUT}/health.png", full_page=True)
    # supplies
    pg.click("[data-tab=supplies]"); pg.wait_for_timeout(200)
    pg.click("[aria-label='Flea tablets running low']"); pg.wait_for_timeout(300)
    ok("flea tablets low", "1 running low" in pg.inner_text("#view"))
    pg.screenshot(path=f"{OUT}/supplies.png", full_page=True)
    pg.click("[data-tab=today]"); pg.wait_for_timeout(200)
    ok("low banner on Today", "Running low: Flea tablets" in pg.inner_text("#view"))
    # settings + backup
    pg.click("#account"); pg.wait_for_selector("#settings[open]")
    ok("settings shows vet", "01 539 2330" in pg.inner_text("#settings"))
    pg.screenshot(path=f"{OUT}/settings.png")
    with pg.expect_download() as dl: pg.click("#backup")
    path = dl.value.path(); import json; data = json.load(open(path))
    ok("backup json", dl.value.suggested_filename.startswith("art-backup-") and len(data["items"]) == 26 and len(data["health"]) == 2 and data["app"] == "art")
    ok("no console errors", not errors)
    if errors: print(errors)
    b.close()
fails = [n for n, c in results if not c]
print(f"{len(results) - len(fails)}/{len(results)} passed"); sys.exit(1 if fails else 0)
