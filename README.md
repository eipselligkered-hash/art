# Art – dog care checklist (sibling of the Chores app)

A small, mobile-first web app for Art (white-and-black lurcher, born June 2020, about 20 kg). Same look, same login and same
Supabase project as the [Chores app](https://github.com/eipselligkered-hash/chores). Plain HTML/CSS/JS, no build step, PWA.

* **Today** – Morning walk, Breakfast, Evening walk, Dinner. Tap ✓ = done today (tap again to untick); long-press or ⋯ = pick a date; Undo.
  *Ticking as Derek / Peter / Nobody* (saved per phone) records who did it. Below: treatments that are **Overdue**, **Due soon** or **To book**,
  and a *Running low* line from Supplies.
* **Care** – every treatment/vet item with next due and status, soonest first; **+ Add item**; tap a name for the item sheet:
  next due, short history (with who; *remove* a tick), notes, ✓ Done today, Pick a date…, ✎ Edit (rename, how often, Last done,
  *Due / booked for* date, notes, retire via *Active*).
* **Health** – latest weight, vet details (tap to call), dated free-text entries with optional weight in kg; tap to edit/delete (Undo).
* **Supplies** – food, treats, flea tablets, worming tablets (+ your own) with a *running low* switch.
* **Settings** (⚙ top right) – Ticking as, vet, **Download backup** (`art-backup-YYYY-MM-DD.json` – keep it private), sign out.
* Offline: last loaded data is cached per user and shown straight away; supabase-js is vendored and cached by the service worker.

## Rules
* **Next due** = *Due / booked for* date while nothing has been ticked on/after it; otherwise Last done (latest of typed Last done and ticks)
  + the interval (calendar months for monthly/yearly, clamped to the month end). Ticking uses up the due date (kept on the tick, so
  Undo / *remove* / CLI `undo` puts it back).
* **Status**: Overdue (before today) · Due soon (within 7 days; a month for yearly/6-monthly, 2–3 days for weekly/fortnightly) · OK ·
  To book (one-off without a date) · No date · Done (one-off ticked). Daily items: Done / To do for today.
* Seed (24/10/2026): worming, flea tablet and wash due now (24/10/2026); vaccine booster last 15/08/2026 → due 15/08/2027; teeth cleaning to book.

## Files
| Path | What |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | the app (Chores styles + a few additions) |
| `src/care.js` | pure rules: next due, status, dates (dd/mm/yyyy, week from Monday), fuzzy names |
| `src/data.js` | `MockBackend` (localStorage, from `data/seed.json`) and `SupabaseBackend` (art_* tables, magic link + email code) |
| `data/seed.json` | Art's starting list – the app inserts it on the first sign-in |
| `config.js` | Supabase URL + anon key (same as Chores), dog + vet details |
| `supabase/schema.sql` | `art_items`, `art_ticks`, `art_health`, `art_supplies` + row-level security (owner only, like Chores) |
| `scripts/assistant_cli/cli.mjs` | Dog Care assistant helper (REST + service key, or a mock file) |
| `tests/` | `node --test tests/` (rules, CLI vs fake PostgREST, secrets/schema checks); `tests/smoke_ui.py` (mock) + `tests/smoke_supabase.py` (fake Supabase) with Playwright |
| `manifest.webmanifest`, `sw.js`, `icons/`, `vendor/supabase.js` | PWA + offline |

## Run locally
```bash
python3 -m http.server 8080        # open http://localhost:8080/?backend=mock  (?today=2026-11-24 simulates a date)
node --test tests/
```

## Set up (once)
1. Supabase → **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run** (safe to run again).
2. Supabase → **Authentication → URL Configuration → Redirect URLs** → add `https://eipselligkered-hash.github.io/art/` (keep the Chores one).
3. Open the app and sign in with the same email as Chores (if Chores is already signed in in the same browser, Art is too – same site).
   The first sign-in fills in Art's list. **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android).
   Derek and Peter share the one login, so both see the same list; pick *Ticking as* on each phone.

## Assistant CLI
```bash
export SUPABASE_SERVICE_KEY=...          # service key bypasses RLS – never in config.js or the repo (SUPABASE_URL defaults to the Chores project)
node scripts/assistant_cli/cli.mjs due                    # today's walks/meals, what's due, running low   (--json for machines)
node scripts/assistant_cli/cli.mjs items                  # every item with next due + status
node scripts/assistant_cli/cli.mjs done "worming" "flea" --who Derek [--date 2026-10-24] [--note "..."]
node scripts/assistant_cli/cli.mjs undo "worming"         # removes the latest tick (puts a used-up due date back)
node scripts/assistant_cli/cli.mjs history "flea"
node scripts/assistant_cli/cli.mjs log "Vet check, all fine" --weight 20.4 [--date 2026-10-24]
node scripts/assistant_cli/cli.mjs health | supplies | low "flea tablets" | stocked "flea tablets"
node scripts/assistant_cli/cli.mjs seed                   # only if the app hasn't been opened yet (uses the Chores account)
# offline / testing: --mock /tmp/art.json instead of the key; --today YYYY-MM-DD simulates a date; --dry-run
```
Names are fuzzy (`wormer`, `booster`, `bath`, `teeth` work). Ambiguous names (e.g. `walk`) list the candidates and exit 2.

## Backup / restore
Settings → *Download backup*. To restore into an empty project: run `supabase/schema.sql`, then insert with the service key, parents first –
`art_items`, then `art_ticks`, `art_health`, `art_supplies` (`POST /rest/v1/<table>`, `Prefer: resolution=merge-duplicates`), setting `owner_id`
to the signed-in user's id.
