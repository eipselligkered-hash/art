// Pure care rules for Art's checklist. No dependencies; works in the browser and in Node.
// Dates are ISO strings 'YYYY-MM-DD' in and out; internally whole days since 1970-01-01 (UTC) - no time-zone/DST surprises.
export const FREQUENCIES = {   // name: [days, calendar months]
  'Daily': [1, 0], 'A few times a week': [3, 0], 'Weekly': [7, 0], 'Fortnightly': [14, 0], 'Every 4 weeks': [28, 0], 'Monthly': [0, 1], 'Every 2 months': [0, 2],
  'Every 3 months': [0, 3], 'Every 6 months': [0, 6], 'Yearly': [0, 12], 'One-off': [0, 0],
};
export const WHO = ['Derek', 'Peter'];
export const STATUS_ORDER = ['Overdue', 'Due soon', 'To book', 'No date', 'OK', 'Done'];

const DAY = 86400000;
export const toDay = (iso) => (iso ? Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY) : null);
export const fromDay = (n) => (n == null ? null : new Date(n * DAY).toISOString().slice(0, 10));
export const addDays = (iso, n) => fromDay(toDay(iso) + n);
/** Calendar months, clamped to the month end (31/01 + 1 month = 28/02 or 29/02). */
export function addMonths(iso, months) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
export function addInterval(iso, frequency) {
  const [days, months] = FREQUENCIES[frequency] || [0, 0];
  return months ? addMonths(iso, months) : days ? addDays(iso, days) : null;
}
/** How many days ahead counts as 'Due soon' (yearly/half-yearly: a month, so there's time to book the vet). */
export const soonDays = (frequency) => ({ 'Daily': 0, 'A few times a week': 1, 'Weekly': 2, 'Fortnightly': 3, 'Every 4 weeks': 5, 'Every 6 months': 30, 'Yearly': 30 }[frequency] ?? 7);
/** Frequencies the first version of the database accepted (supabase/migrations/002_frequencies.sql widens it). */
export const V1_FREQUENCIES = ['Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Every 2 months', 'Every 3 months', 'Every 6 months', 'Yearly', 'One-off'];

// ---------- categories: section order on Care (and the full list); old names map to the new ones
export const CATEGORY_ORDER = ['Daily', 'Treatments', 'Grooming', 'Vet & health', 'Home & admin', 'Seasonal'];
export const CATEGORY_RENAMES = { 'Treatment': 'Treatments', 'Vet': 'Vet & health' };
export const UNCATEGORISED = 'Other';
export const normCategory = (item) => {
  const c = String(item.category || '').trim(); if (!c) return isDaily(item) ? 'Daily' : UNCATEGORISED;
  const k = Object.keys(CATEGORY_RENAMES).find((x) => x.toLowerCase() === c.toLowerCase()); if (k) return CATEGORY_RENAMES[k];
  return CATEGORY_ORDER.find((x) => x.toLowerCase() === c.toLowerCase()) || c;
};
/** [[category, rows]] in CATEGORY_ORDER, then other categories A–Z, then uncategorised; rows keep their order. */
export function groupByCategory(rows) {
  const m = new Map(); for (const r of rows) { const c = normCategory(r.item); if (!m.has(c)) m.set(c, []); m.get(c).push(r); }
  const rank = (c) => (c === UNCATEGORISED ? 2e3 : CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : 1e3);
  return [...m].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}
export const isDaily = (item) => item.frequency === 'Daily';
export const isOneOff = (item) => item.frequency === 'One-off';

/** Ticks of one item, newest first. */
export const ticksOf = (itemId, ticks = []) => ticks.filter((t) => t.item_id === itemId)
  .sort((a, b) => b.done_on.localeCompare(a.done_on) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
/** Latest of the typed Last done and any tick. */
export function lastDone(item, ticks = []) {
  let best = item.last_done || null;
  for (const t of ticks) if (t.item_id === item.id && (!best || t.done_on > best)) best = t.done_on;
  return best;
}

/**
 * Next due + status for one item on `today`.
 *  Daily:     status 'Done' (ticked today) or 'To do'.
 *  One-off:   'Done' once ticked; otherwise by its due/booked date, or 'To book' when it has none.
 *  Recurring: next due = due_date while nothing was done on/after it (a known or booked date, or 'due now' for a new item),
 *             else last done + interval. Status: Overdue (before today) / Due soon (within soonDays) / OK / No date.
 */
export function computeItem(item, ticks = [], today) {
  const mine = ticksOf(item.id, ticks), last = lastDone(item, ticks), t0 = toDay(today);
  const r = { item, last, next_due: null, status: 'OK', days: null, today_ticks: mine.filter((t) => t.done_on === today), history: mine };
  if (isDaily(item)) { r.next_due = today; r.days = 0; r.status = r.today_ticks.length ? 'Done' : 'To do'; return r; }
  if (isOneOff(item)) {
    if (mine.length || item.last_done) { r.status = 'Done'; return r; }
    if (!item.due_date) { r.status = 'To book'; return r; }
    r.next_due = item.due_date;
  } else if (item.due_date && !(last && last >= item.due_date)) r.next_due = item.due_date;
  else if (last) r.next_due = addInterval(last, item.frequency);
  if (!r.next_due) { r.status = 'No date'; return r; }
  r.days = toDay(r.next_due) - t0;
  r.status = r.days < 0 ? 'Overdue' : r.days <= soonDays(item.frequency) ? 'Due soon' : 'OK';
  return r;
}
export const computeAll = (items, ticks, today) => items.filter((i) => i.active !== false).map((i) => computeItem(i, ticks, today));
export const byStatus = (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  || (a.next_due || '9999').localeCompare(b.next_due || '9999') || (a.item.sort_key ?? 0) - (b.item.sort_key ?? 0);
export const needsAttention = (r) => ['Overdue', 'Due soon', 'To book', 'No date'].includes(r.status);

/** What ticking `item` done on `doneOn` does: duplicate = already ticked that day (nothing to add);
 *  patch = item fields to change (a due/booked date is used up by the tick); cleared_due = that date, kept on the tick
 *  so removing the tick later (Undo, history 'remove', CLI undo) can put it back. */
export function planTick(item, ticks, doneOn) {
  const duplicate = ticks.some((t) => t.item_id === item.id && t.done_on === doneOn);
  const patch = {}, cleared_due = item.due_date && !isDaily(item) ? item.due_date : null;
  if (cleared_due) patch.due_date = null;
  return { duplicate, patch, cleared_due };
}
/** Removing a tick that used up a due/booked date puts the date back (unless a new one has been set since). */
export const restoreOnRemove = (item, tick) => (tick?.cleared_due && !item.due_date ? { due_date: tick.cleared_due } : null);

// ---------- display (Irish/UK: dd/mm/yyyy, week starts Monday)
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function fmtDate(iso, { long = false, short = false } = {}) {
  if (!iso) return '–';
  const d = new Date(toDay(iso) * DAY), dd = String(d.getUTCDate()).padStart(2, '0'), mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (short) return `${WEEKDAYS[d.getUTCDay()]} ${dd}/${mm}`;
  return `${(long ? LONG_WD : WEEKDAYS)[d.getUTCDay()]} ${dd}/${mm}/${d.getUTCFullYear()}`;
}
/** 'due today', 'due tomorrow', 'due in 5 days', '3 days overdue', 'due Sun 15/08/2027' */
export function dueText(r) {
  if (r.status === 'Done') return r.last ? `done ${fmtDate(r.last)}` : 'done';
  if (r.status === 'To book') return 'not booked yet';
  if (!r.next_due) return 'no date';
  const d = r.days;
  if (d === 0) return 'due today';
  if (d === 1) return 'due tomorrow';
  if (d === -1) return '1 day overdue';
  if (d < 0) return `${-d} days overdue`;
  if (d <= 14) return `due in ${d} days`;
  return `due ${fmtDate(r.next_due)}`;
}
export const monday = (iso) => { const n = toDay(iso); return fromDay(n - ((new Date(n * DAY).getUTCDay() + 6) % 7)); };
export const timeOf = (ts) => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' }); };
export const validWeight = (v) => { const s = String(v ?? '').trim().replace(',', '.'); if (!s) return null; const n = Number(s); return n > 0 && n < 100 ? Math.round(n * 10) / 10 : NaN; };
export function latestWeight(health = []) {
  return health.filter((h) => h.weight_kg != null).sort((a, b) => b.entry_date.localeCompare(a.entry_date) || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

// ---------- fuzzy matching (assistant CLI): exact name, then all words, then bigram similarity
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const bigrams = (s) => { const b = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); b.set(k, (b.get(k) || 0) + 1); } return b; };
const dice = (a, b) => { const A = bigrams(a), B = bigrams(b); let n = 0; for (const [k, v] of A) n += Math.min(v, B.get(k) || 0); return (2 * n) / Math.max(1, a.length + b.length - 2); };
const ALIAS = { wormer: 'worming', worm: 'worming', flea: 'flea', bath: 'wash', teeth: 'teeth', dental: 'teeth' };
export function matchByName(q, rows, name = (x) => x.name) {
  const nq = norm(q).split(' ').map((w) => ALIAS[w] || w).join(' ');
  let c = rows.filter((x) => norm(name(x)) === nq);
  if (c.length === 1) return { match: c[0], how: 'exact' };
  const words = nq.split(' ').filter(Boolean);
  c = rows.filter((x) => words.every((w) => norm(name(x)).includes(w)));
  if (c.length === 1) return { match: c[0], how: 'words' };
  if (c.length > 1) return { candidates: c };
  const s = rows.map((x) => ({ x, s: dice(nq, norm(name(x))) })).sort((a, b) => b.s - a.s);
  if (s[0] && s[0].s >= 0.5 && (!s[1] || s[0].s - s[1].s >= 0.08)) return { match: s[0].x, how: `similar (${s[0].s.toFixed(2)})` };
  return { candidates: s.slice(0, 5).map((y) => y.x) };
}
