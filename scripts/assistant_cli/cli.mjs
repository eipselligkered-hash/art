#!/usr/bin/env node
// Dog Care assistant helper for Art: read what's due and mark things done, via the Supabase REST API (PostgREST) or a local mock file.
//
//   node scripts/assistant_cli/cli.mjs due      [--today YYYY-MM-DD] [--json]   today's walks/meals, treatments due, supplies running low
//   node scripts/assistant_cli/cli.mjs items    [--json]                         every active item with next due + status
//   node scripts/assistant_cli/cli.mjs done "worming" "flea" [--date YYYY-MM-DD] [--who Derek|Peter] [--note TEXT] [--dry-run]
//   node scripts/assistant_cli/cli.mjs undo "worming"                            removes the latest tick for that item
//   node scripts/assistant_cli/cli.mjs history "flea" [--json]                   last ticks of one item
//   node scripts/assistant_cli/cli.mjs log "Vet check, all fine" [--weight 20.4] [--date YYYY-MM-DD]   add a health-log entry
//   node scripts/assistant_cli/cli.mjs health   [--json]                         health log, newest first
//   node scripts/assistant_cli/cli.mjs supplies [--json]  |  low "flea tablets"  |  stocked "flea tablets"
//   node scripts/assistant_cli/cli.mjs sync [--owner UUID] [--dry-run]           add what's missing from data/seed.json (by name), apply category renames
//                                                                                 (also first-time setup when the app hasn't been opened yet; 'seed' = alias)
//
// Backend: SUPABASE_URL (default: the Chores/Art project) + SUPABASE_SERVICE_KEY env vars -> REST. The service key bypasses RLS:
//          keep it secret, never in the web app. Rows are scoped to one owner (the only one with Art data, or --owner / ART_OWNER).
//          --mock FILE (or ART_MOCK=FILE) -> local JSON file, created from data/seed.json if missing.
import fs from 'node:fs';
import path from 'node:path';
import { computeAll, computeItem, byStatus, needsAttention, planTick, restoreOnRemove, fmtDate, dueText, isDaily, matchByName, ticksOf, validWeight, latestWeight, timeOf, WHO } from '../../src/care.js';
import { seedRows, syncSeed } from '../../src/data.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DEFAULT_URL = 'https://rwbiizjwvyssdyxjuqan.supabase.co';
const T = { items: 'art_items', ticks: 'art_ticks', health: 'art_health', supplies: 'art_supplies' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class RestStore {
  constructor(url, key, owner = null) { this.base = url.replace(/\/$/, '') + '/rest/v1'; this.h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }; this.owner = owner; }
  async req(method, p, body, prefer) {
    const r = await fetch(this.base + p, { method, headers: { ...this.h, ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const txt = await r.text();
      if (/PGRST205|art_\w+.*schema cache/.test(txt)) throw new Error('The art_* tables do not exist yet – run supabase/schema.sql in the Supabase SQL Editor first.');
      throw new Error(`${method} ${p}: ${r.status} ${txt}`);
    }
    return r.status === 204 || r.status === 201 && !prefer?.includes('representation') ? null : r.json();
  }
  async load() {
    if (!this.owner) {
      const own = await this.req('GET', `/${T.items}?select=owner_id`);
      const ids = [...new Set(own.map((r) => r.owner_id))];
      if (ids.length > 1) throw new Error(`Art data exists for several accounts (${ids.join(', ')}) – pass --owner UUID or set ART_OWNER.`);
      this.owner = ids[0] || null;
    }
    if (!this.owner) return { items: [], ticks: [], health: [], supplies: [], owner: null };
    const o = `owner_id=eq.${encodeURIComponent(this.owner)}`;
    const [items, ticks, health, supplies] = await Promise.all([
      this.req('GET', `/${T.items}?select=*&${o}&order=sort_key.asc`), this.req('GET', `/${T.ticks}?select=*&${o}&order=done_on.asc`),
      this.req('GET', `/${T.health}?select=*&${o}&order=entry_date.desc`), this.req('GET', `/${T.supplies}?select=*&${o}&order=sort_key.asc`),
    ]);
    return { items, ticks, health, supplies, owner: this.owner };
  }
  async add(table, row) { const [r] = await this.req('POST', `/${T[table]}`, { owner_id: this.owner, ...row }, 'return=representation'); return r; }
  async addMany(table, rows) { if (rows.length) await this.req('POST', `/${T[table]}`, rows.map((r) => ({ owner_id: this.owner, ...r })), 'return=minimal'); }
  async patch(table, id, patch) { await this.req('PATCH', `/${T[table]}?id=eq.${encodeURIComponent(id)}`, patch); }
  async del(table, id) { await this.req('DELETE', `/${T[table]}?id=eq.${encodeURIComponent(id)}`); }
  /** owner for a first-time seed: --owner, else the (single) owner of the Chores tasks = the shared login */
  async guessOwner() {
    const rows = await this.req('GET', '/tasks?select=owner_id').catch(() => []);
    const ids = [...new Set(rows.map((r) => r.owner_id))];
    return ids.length === 1 ? ids[0] : null;
  }
}

export class FileStore {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) {
      const s = seedRows(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed.json')))); let n = 0;
      const stamp = (r) => ({ id: `mock-${++n}`, created_at: new Date().toISOString(), ...r });
      this.write({ items: s.items.map(stamp), ticks: [], health: s.health.map(stamp), supplies: s.supplies.map(stamp) });
    }
    return JSON.parse(fs.readFileSync(this.file));
  }
  write(db) { fs.writeFileSync(this.file, JSON.stringify(db, null, 1)); }
  async load() { return { ...this.read(), owner: 'mock' }; }
  async add(table, row) { const db = this.read(); const r = { id: `cli-${Date.now()}-${db[table].length}`, created_at: new Date().toISOString(), ...row }; db[table].push(r); this.write(db); return r; }
  async addMany(table, rows) { for (const r of rows) await this.add(table, r); }
  async patch(table, id, patch) { const db = this.read(); Object.assign(db[table].find((x) => x.id === id), patch); this.write(db); }
  async del(table, id) { const db = this.read(); db[table] = db[table].filter((x) => x.id !== id); this.write(db); }
  async guessOwner() { return 'mock'; }
}

const statusIcon = (s) => ({ Overdue: '❗', 'Due soon': '⏰', 'To book': '📞', Done: '✓', OK: '·', 'No date': '·' }[s] || '·');
const itemLine = (r) => `${statusIcon(r.status)} ${r.item.name} · ${r.item.frequency} · ${r.status} – ${dueText(r)}${r.last ? ` · last ${fmtDate(r.last)}` : ''}`;
const rowJson = (r) => ({ name: r.item.name, category: r.item.category || null, frequency: r.item.frequency, status: r.status, next_due: r.next_due, due_text: dueText(r), last_done: r.last,
  done_today: r.today_ticks.map((t) => ({ who: t.who || null, at: t.created_at || null })), notes: r.item.notes || null });

export async function main(argv = process.argv.slice(2)) {
  argv = [...argv];
  const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
  const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const mock = opt('--mock') || process.env.ART_MOCK;
  const today = opt('--today') || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
  const date = opt('--date'), whoArg = opt('--who'), note = opt('--note'), weightArg = opt('--weight'), ownerArg = opt('--owner') || process.env.ART_OWNER || null;
  const json = flag('--json'), dry = flag('--dry-run');
  const [cmd, ...rest] = argv;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const store = mock ? new FileStore(mock) : key ? new RestStore(process.env.SUPABASE_URL || DEFAULT_URL, key, ownerArg) : null;
  if (!store || !cmd) { console.error('usage: cli.mjs due|items|done|undo|history|log|health|supplies|low|stocked|seed ... (set SUPABASE_SERVICE_KEY [+ SUPABASE_URL], or --mock FILE)'); return 1; }
  if (date && !ISO.test(date)) { console.error('--date must be YYYY-MM-DD'); return 1; }
  if (date && date > today) { console.error(`--date ${date} is in the future (today is ${today})`); return 1; }
  const who = whoArg ? WHO.find((w) => w.toLowerCase() === whoArg.toLowerCase()) : null;
  if (whoArg && !who) { console.error(`--who must be one of ${WHO.join(', ')}`); return 1; }

  const db = await store.load();
  if (cmd === 'seed' || cmd === 'sync') {
    if (!db.owner) {
      const owner = ownerArg || await store.guessOwner();
      if (!owner) { console.error('Could not tell which account to use – pass --owner UUID (the user id from Supabase > Authentication > Users).'); return 1; }
      store.owner = owner; db.owner = owner;
    }
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed.json')));
    if (dry) {
      const { planSeedSync } = await import('../../src/data.js'); const p = planSeedSync(db, seed);
      console.log(`[dry-run] for ${db.owner}: add ${p.items.length} items${p.items.length ? ` (${p.items.map((i) => i.name).join(', ')})` : ''}, ${p.supplies.length} supplies, ${p.health.length} health entries; ${p.patches.length} updates`); return 0;
    }
    const r = await syncSeed(store, db, seed);
    console.log(r.changed ? `Synced for ${db.owner}: added ${r.items.length} items${r.items.length ? ` (${r.items.join(', ')})` : ''}, ${r.supplies.length} supplies${r.supplies.length ? ` (${r.supplies.join(', ')})` : ''}, ${r.health} health entries; ${r.patched} updates (category renames / notes)` : 'Nothing to add – Art already has everything in the seed.');
    for (const k of r.skipped) console.log(`! skipped ${k.name}: ${/frequency_check/.test(k.why) ? 'needs supabase/migrations/002_frequencies.sql' : k.why}`);
    return r.complete ? 0 : 2;
  }
  if (!db.owner || (!db.items.length && cmd !== 'log')) { console.error('No Art data yet – open the app once and sign in (it sets up Art’s list), or run: cli.mjs sync'); return 1; }

  const rows = computeAll(db.items, db.ticks, today);
  const daily = rows.filter((r) => isDaily(r.item)), care = rows.filter((r) => !isDaily(r.item)).sort(byStatus);
  const low = db.supplies.filter((s) => s.low);
  const find = (q, list = db.items.filter((i) => i.active !== false)) => matchByName(q, list);

  if (cmd === 'due') {
    const due = care.filter(needsAttention), next = care.filter((r) => r.status === 'OK')[0];
    if (json) { console.log(JSON.stringify({ today, daily: daily.map(rowJson), due: due.map(rowJson), next: next ? rowJson(next) : null, running_low: low.map((s) => s.name), weight: latestWeight(db.health) }, null, 1)); return 0; }
    console.log(`Art – ${fmtDate(today, { long: true })}`);
    console.log(`\nToday (${daily.filter((r) => r.status === 'Done').length}/${daily.length} done)`);
    daily.forEach((r) => { const t = r.today_ticks[0]; console.log(`${t ? '✓' : '○'} ${r.item.name}${t ? ` – ${[timeOf(t.created_at), t.who].filter(Boolean).join(', ') || 'done'}` : ''}`); });
    console.log(due.length ? `\nDue (${due.length})` : '\nNo treatments due.'); due.forEach((r) => console.log(itemLine(r)));
    if (next) console.log(`\nNext: ${next.item.name} – ${dueText(next)}`);
    if (low.length) console.log(`\nRunning low: ${low.map((s) => s.name).join(', ')}`);
    return 0;
  }
  if (cmd === 'items') {
    const all = [...care, ...daily];
    if (json) console.log(JSON.stringify(all.map(rowJson), null, 1)); else all.forEach((r) => console.log(itemLine(r)));
    return 0;
  }
  if (cmd === 'history') {
    const m = find(rest.join(' ')); if (!m.match) return ambiguous(rest.join(' '), m);
    const h = ticksOf(m.match.id, db.ticks).slice(0, 20);
    if (json) console.log(JSON.stringify(h, null, 1));
    else { console.log(`${m.match.name}:`); h.forEach((t) => console.log(`  ${fmtDate(t.done_on)}${t.who ? ` · ${t.who}` : ''}${t.source === 'assistant' ? ' · assistant' : ''}${t.note ? ` · ${t.note}` : ''}`)); if (!h.length) console.log(m.match.last_done ? `  last done ${fmtDate(m.match.last_done)} (typed)` : '  never ticked'); }
    return 0;
  }
  if (cmd === 'done' || cmd === 'undo') {
    let rc = 0; const d = date || today;
    for (const q of rest) {
      const m = find(q); if (!m.match) { rc = ambiguous(q, m); continue; }
      const it = m.match;
      if (cmd === 'undo') {
        const t = ticksOf(it.id, db.ticks)[0];
        if (!t) { console.log(`- ${it.name} has no ticks to undo`); continue; }
        const back = restoreOnRemove(it, t);
        if (!dry) { await store.del('ticks', t.id); if (back) await store.patch('items', it.id, back); }
        db.ticks = db.ticks.filter((x) => x.id !== t.id); if (back) Object.assign(it, back);
        console.log(`${dry ? '[dry-run] would undo' : '↶ undone'} ${it.name} (${fmtDate(t.done_on)}) → ${dueText(computeItem(it, db.ticks, today))}`); continue;
      }
      const p = planTick(it, db.ticks, d);
      if (p.duplicate) { console.log(`- ${it.name} is already marked done ${fmtDate(d)} (nothing added)`); continue; }
      if (!dry) {
        const t = await store.add('ticks', { item_id: it.id, done_on: d, who, note, source: 'assistant', ...(p.cleared_due ? { cleared_due: p.cleared_due } : {}) });
        db.ticks.push(t || { item_id: it.id, done_on: d });
        if (Object.keys(p.patch).length) { await store.patch('items', it.id, p.patch); Object.assign(it, p.patch); }
      }
      const after = computeItem(dry ? { ...it, ...p.patch } : it, dry ? [...db.ticks, { item_id: it.id, done_on: d }] : db.ticks, today);
      console.log(`${dry ? '[dry-run] would mark' : '✓ marked'} ${it.name} done ${fmtDate(d)}${who ? ` (${who})` : ''} (${m.how})${isDaily(it) ? '' : ` → next due ${fmtDate(after.next_due)}`}`);
    }
    return rc;
  }
  if (cmd === 'log') {
    const text = rest.join(' ').trim(), w = validWeight(weightArg);
    if (Number.isNaN(w)) { console.error('--weight must be a number of kg, e.g. 20.4'); return 1; }
    if (!text && w == null) { console.error('usage: log "what happened" [--weight KG] [--date YYYY-MM-DD]'); return 1; }
    if (!dry) await store.add('health', { entry_date: date || today, text, weight_kg: w });
    console.log(`${dry ? '[dry-run] would add' : '📓 added'} ${fmtDate(date || today)}: ${text}${w != null ? ` (${w} kg)` : ''}`); return 0;
  }
  if (cmd === 'health') {
    const h = db.health.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date));
    if (json) console.log(JSON.stringify(h, null, 1)); else h.forEach((e) => console.log(`${fmtDate(e.entry_date)}${e.weight_kg != null ? ` · ${Number(e.weight_kg)} kg` : ''} · ${e.text}`));
    return 0;
  }
  if (cmd === 'supplies') {
    if (json) console.log(JSON.stringify(db.supplies.map((s) => ({ name: s.name, low: !!s.low, notes: s.notes || null })), null, 1));
    else db.supplies.forEach((s) => console.log(`${s.low ? '⚠ running low' : '✓ stocked    '}  ${s.name}${s.notes ? ` · ${s.notes}` : ''}`));
    return 0;
  }
  if (cmd === 'low' || cmd === 'stocked') {
    let rc = 0;
    for (const q of rest) {
      const m = find(q, db.supplies); if (!m.match) { rc = ambiguous(q, m); continue; }
      if (!dry) await store.patch('supplies', m.match.id, { low: cmd === 'low' });
      console.log(`${dry ? '[dry-run] ' : ''}${m.match.name} → ${cmd === 'low' ? 'running low' : 'stocked'}`);
    }
    return rc;
  }
  console.error(`unknown command ${cmd}`); return 1;
}
function ambiguous(q, m) { console.log(`? "${q}" is ambiguous/unknown – did you mean:\n${(m.candidates || []).map((x) => `   ${x.name}`).join('\n') || '   (nothing close)'}`); return 2; }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(1); });
