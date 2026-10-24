import { FREQUENCIES, WHO, computeAll, computeItem, byStatus, needsAttention, planTick, fmtDate, dueText, addDays, timeOf, validWeight,
  latestWeight, isDaily, isOneOff, lastDone, monday, restoreOnRemove } from './care.js?v=1';
import { makeBackend } from './data.js?v=1';

const VER = 'v1';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (s) => String(s).replace(/[()]/g, '').replace(/\s+/g, '-');
const params = new URLSearchParams(location.search);
const localToday = () => params.get('today') || new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, device time zone
const CFG = window.ART_CONFIG || {};

const be = makeBackend();
const state = { tab: params.get('tab') || 'today', db: null, who: localStorage.getItem('art.who') || '' };

// only the most recent load is shown, so a slow older response can't overwrite newer data
let loadSeq = 0;
async function refresh() {
  const n = ++loadSeq; let db;
  try {
    if (be.kind !== 'mock' && !navigator.onLine) throw new Error('offline');
    // a paused/unreachable project or a flaky connection can hang for a long time: give up after 15 s
    db = await Promise.race([be.load(), new Promise((_, ko) => setTimeout(() => ko(new Error('Timed out reaching the database')), 15000))]);
    if (await be.seedIfEmpty(db)) db = await be.load();   // first sign-in: Art's starting list
  } catch (err) {
    if (n === loadSeq) { state.conn = connProblem(err); state.connErr = String(err?.message || err); if (state.db) render(); else renderUnreachable(); }
    throw err;
  }
  if (n !== loadSeq) return;
  state.db = db; state.conn = ''; saveCache(db); render();
}
// ---------- connection problems, offline cache
const isNetErr = (err) => !navigator.onLine || /failed to fetch|networkerror|load failed|network|offline|fetch/i.test(String(err?.message || err));
const connProblem = (err) => (!navigator.onLine ? 'offline' : /jwt|token|not authenticated|auth session/i.test(String(err?.message || err)) ? 'auth'
  : /not set up yet/.test(String(err?.message || err)) ? 'schema' : 'unreachable');
const errMsg = (err) => (isNetErr(err) ? 'You’re offline or the database can’t be reached – not saved. Try again later.' : `Couldn't save – ${err?.message || err}`);
const offlineNow = () => be.kind !== 'mock' && !navigator.onLine;
const fail = (err) => { console.error(err); if (state.db) render(); toast(errMsg(err)); refresh().catch(() => {}); };
const DASH = 'https://supabase.com/dashboard/project/rwbiizjwvyssdyxjuqan';
function connMessage() {
  if (state.conn === 'offline') return `<b>📴 You're offline</b> – showing what was saved on this device. Ticks and edits can't be saved until you're back online.`;
  if (state.conn === 'auth') return `<b>Your sign-in has expired.</b> Sign in again to see Art's latest. <button type="button" class="link" data-relogin>Sign in again</button>`;
  if (state.conn === 'schema') return `<b>Art's tables aren't set up yet.</b> In the <a href="${DASH}/sql/new" target="_blank" rel="noopener">Supabase SQL Editor</a>, paste all of <code>supabase/schema.sql</code> and Run, then tap Retry.`;
  return `<b>Can't reach the database</b> – it may be paused (free plan pauses after a week unused). Restore it at <a href="${DASH}" target="_blank" rel="noopener">supabase.com</a>, then tap Retry.`;
}
const connBanner = () => (state.conn && state.conn !== 'updating' ? `<div class="banner conn" role="alert"><span>${connMessage()}</span><button type="button" class="ghost" data-retry>Retry</button></div>` : '');
function renderUnreachable() {
  if (!state.conn || state.conn === 'updating') state.conn = navigator.onLine ? 'unreachable' : 'offline';
  $('#today').textContent = fmtDate(localToday(), { long: true });
  $('#view').innerHTML = `<div class="card conn-card" role="alert"><p>${connMessage()}</p><button type="button" class="primary wide" data-retry>Retry</button></div>`;
}
const cacheKey = () => (be.kind === 'supabase' && be.user?.id ? `art.cache.v1.${be.user.id}` : null);
function saveCache(db) { const k = cacheKey(); if (k) try { localStorage.setItem(k, JSON.stringify({ saved_at: new Date().toISOString(), db })); } catch { /* full: skip */ } }
function readCache() { const k = cacheKey(); try { return k ? JSON.parse(localStorage.getItem(k) || 'null') : null; } catch { return null; } }
const clearCaches = () => Object.keys(localStorage).filter((k) => k.startsWith('art.cache.')).forEach((k) => localStorage.removeItem(k));
async function retry() {
  if (!be.ready) return location.reload();
  state.conn = 'updating'; if (state.db) render(); else $('#view').innerHTML = '<p class="empty">Loading…</p>';
  refresh().catch(console.error);
}
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (err) { fail(err); } };
const itemById = (id) => state.db?.items.find((x) => x.id === id);

// ---------- actions
const busy = new Set();   // items with a save in flight (repeated taps)
async function markDone(itemId, doneOn) {
  const it = itemById(itemId); if (!it || busy.has(itemId)) return;
  if (offlineNow()) return fail(new Error('offline'));
  const p = planTick(it, state.db.ticks, doneOn);
  if (p.duplicate) { render(); return toast(`${it.name} – already done ${doneOn === localToday() ? 'today' : fmtDate(doneOn)}`); }
  const prev = Object.fromEntries(Object.keys(p.patch).map((k) => [k, it[k] ?? null]));
  busy.add(itemId); let tick;
  try {
    tick = await be.add('ticks', { item_id: itemId, done_on: doneOn, who: state.who || null, source: 'app', ...(p.cleared_due ? { cleared_due: p.cleared_due } : {}) });
    if (Object.keys(p.patch).length) await be.patch('items', itemId, p.patch);
  } catch (err) { busy.delete(itemId); return fail(err); }
  await refresh().catch(console.error).finally(() => busy.delete(itemId));
  const r = computeItem({ ...it, ...p.patch }, state.db.ticks, localToday());
  const nxt = !isDaily(it) && r.next_due ? ` · next ${fmtDate(r.next_due)}` : '';
  toast(`${it.name} – done ${doneOn === localToday() ? 'today' : fmtDate(doneOn)}${state.who ? ` (${state.who})` : ''}${nxt}`, async () => {
    await be.del('ticks', tick.id);
    if (Object.keys(prev).length) await be.patch('items', itemId, prev);
    await refresh();
  });
}
// tapping a daily item that's already ticked today unticks it (with Undo)
async function untickToday(it) {
  if (offlineNow()) return fail(new Error('offline'));
  const ts = state.db.ticks.filter((t) => t.item_id === it.id && t.done_on === localToday());
  try { for (const t of ts) await be.del('ticks', t.id); } catch (err) { return fail(err); }
  await refresh().catch(console.error);
  toast(`${it.name} – unticked`, async () => { for (const t of ts) await be.add('ticks', strip(t)); await refresh(); });
}
const strip = (t) => ({ item_id: t.item_id, done_on: t.done_on, who: t.who ?? null, note: t.note ?? null, source: t.source || 'app', ...(t.cleared_due ? { cleared_due: t.cleared_due } : {}) });
async function removeTick(id) {
  const t = state.db.ticks.find((x) => x.id === id), it = t && itemById(t.item_id); if (!t || !it) return;
  if (offlineNow()) return fail(new Error('offline'));
  const back = restoreOnRemove(it, t);
  try { await be.del('ticks', id); if (back) await be.patch('items', it.id, back); } catch (err) { return fail(err); }
  await refresh().catch(console.error);
  toast(`Removed ${fmtDate(t.done_on)}`, async () => { await be.add('ticks', strip(t)); if (back) await be.patch('items', it.id, { due_date: null }); await refresh(); });
}

let toastTimer;
function toast(msg, undo) {
  const t = $('#toast'); clearTimeout(toastTimer);
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`;
  t.hidden = false;
  if (undo) $('#undo').onclick = async () => { t.hidden = true; await safe(undo)(); };
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
function pickDate(it) {
  const d = $('#sheet'); $('#sheet-task').textContent = it.name;
  const inp = $('#sheet-date'); inp.value = localToday(); inp.max = localToday();
  const last = lastDone(it, state.db.ticks), note = $('#sheet-note');
  inp.oninput = inp.onchange = () => {
    const dup = state.db.ticks.some((t) => t.item_id === it.id && t.done_on === inp.value);
    note.textContent = dup ? 'Already ticked that day.' : last ? `Last done ${fmtDate(last)}${state.who ? ` · ticking as ${state.who}` : ''}` : (state.who ? `Ticking as ${state.who}` : '');
  };
  inp.oninput();
  d.returnValue = ''; d.showModal();
  d.onclose = () => { if (d.returnValue === 'ok' && inp.value) markDone(it.id, inp.value); };
}

// ---------- rendering
const statusChip = (s) => `<span class="chip s-${cls(s)}">${esc(s)}</span>`;
const whoChip = (w) => (w ? `<span class="chip who-chip">${esc(w)}</span>` : '');
function dailyRow(r) {
  const it = r.item, t = r.today_ticks[0], done = !!t;
  return `<div class="item ${done ? 'ticked' : ''}" data-id="${it.id}">
    <button class="tick ${done ? 'done' : ''}" data-act="done" aria-label="${done ? 'Untick' : 'Mark'} ${esc(it.name)} ${done ? '' : 'done today'}" aria-pressed="${done}">✓</button>
    <div class="body"><div class="name">${esc(it.name)}</div>
      <div class="meta">${done ? `<span>✓ ${esc(timeOf(t.created_at)) || 'done'}</span>${whoChip(t.who)}` : '<span>not yet</span>'}</div></div>
    <button class="more" data-act="date" aria-label="Done on another date">⋯</button></div>`;
}
function careRow(r) {
  const it = r.item, doneToday = r.today_ticks.length > 0;
  return `<div class="item" data-id="${it.id}">
    <button class="tick ${doneToday ? 'done' : ''}" data-act="done" aria-label="Mark ${esc(it.name)} done today">✓</button>
    <div class="body"><div class="name">${esc(it.name)}</div>
      <div class="meta">${it.category ? `<span class="cat">${esc(it.category)}</span>` : ''}<span>${esc(it.frequency)}</span>${statusChip(r.status)}<span>${esc(dueText(r))}</span></div></div>
    <button class="more" data-act="date" aria-label="Done on another date">⋯</button></div>`;
}
const section = (title, rows, note = '', klass = '') => rows.length
  ? `<h2 class="sec">${title}<small>${note}</small></h2><div class="list ${klass}">${rows.join('')}</div>` : '';
const whoSeg = () => `<div class="who"><div class="lbl">Ticking as</div><div class="seg">${WHO.map((w) => `<button data-who="${w}" class="${state.who === w ? 'on' : ''}">${w}</button>`).join('')}<button data-who="" class="${state.who ? '' : 'on'}">Nobody</button></div></div>`;
function lowBanner() {
  const low = state.db.supplies.filter((s) => s.low);
  return low.length ? `<div class="banner low"><span>🛒 Running low: ${esc(low.map((s) => s.name).join(', '))}</span><button class="link" data-goto="supplies">Supplies</button></div>` : '';
}

function renderToday() {
  const today = localToday(), rows = computeAll(state.db.items, state.db.ticks, today);
  const daily = rows.filter((r) => isDaily(r.item)).sort((a, b) => (a.item.sort_key ?? 0) - (b.item.sort_key ?? 0));
  const due = rows.filter((r) => !isDaily(r.item) && needsAttention(r)).sort(byStatus);
  const nDone = daily.filter((r) => r.status === 'Done').length, pct = daily.length ? (nDone / daily.length) * 100 : 0;
  const doneToday = rows.filter((r) => !isDaily(r.item) && r.today_ticks.length);
  let h = lowBanner() + whoSeg() + `<div class="card progress"><div class="nums"><div><span class="big">${nDone}</span> <span class="of">of ${daily.length} done today</span></div><div class="of">${fmtDate(today, { short: true })}</div></div>
    <div class="bar" role="img" aria-label="${nDone} of ${daily.length} done"><span class="done" style="width:${pct.toFixed(1)}%"></span></div></div>`;
  h += section('Today', daily.map(dailyRow), 'walks & meals');
  h += due.length ? section('💊 Due', due.map(careRow), 'treatments & vet') : `<div class="card empty">No treatments due 🎉<br><span class="small">Next: ${esc(nextUp(rows))}</span></div>`;
  h += section('Done today', doneToday.map(careRow), '');
  h += `<p class="hint">Tap ✓ = done today (tap again on a walk or meal to untick); long-press or ⋯ = pick a date. Tap a name for history and notes.</p>`;
  return h;
}
function nextUp(rows) {
  const r = rows.filter((x) => !isDaily(x.item) && x.next_due).sort(byStatus)[0];
  return r ? `${r.item.name} – ${dueText(r)}` : 'nothing scheduled';
}

function renderCare() {
  const today = localToday(), rows = computeAll(state.db.items, state.db.ticks, today);
  const care = rows.filter((r) => !isDaily(r.item)).sort(byStatus), daily = rows.filter((r) => isDaily(r.item));
  const counts = {}; care.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
  let h = `<div class="toolbar"><button class="primary add" data-add style="flex:1">+ Add item</button><button class="ghost gear" data-settings aria-label="Settings">⚙</button></div>
    <div class="summary" style="margin-top:10px">${['Overdue', 'Due soon', 'To book', 'No date', 'OK', 'Done'].filter((s) => counts[s]).map((s) => `<span class="chip s-${cls(s)}">${counts[s]} ${s}</span>`).join('')}</div>`;
  h += section('Treatments & vet', care.map(careRow), 'soonest first');
  h += section('Every day', daily.map(dailyRow), '');
  const retired = state.db.items.filter((i) => i.active === false).sort((a, b) => a.name.localeCompare(b.name));
  if (retired.length) h += `<details class="room retired"><summary><span>Retired <small class="muted">(${retired.length})</small></span></summary>
    ${retired.map((i) => `<div class="item" data-tid="${i.id}"><div class="body"><div class="name">${esc(i.name)}</div><div class="meta"><span>${esc(i.frequency)}</span></div></div></div>`).join('')}</details>`;
  return h + `<p class="hint">Tap a name for history, notes and ✎ Edit (rename, change how often, set a booked date, retire).</p>`;
}

function renderHealth() {
  const db = state.db, w = latestWeight(db.health), v = CFG.vet || {};
  const list = db.health.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  let h = `<div class="card weight-card"><div><div class="muted small">${esc(CFG.dog?.name || 'Art')} · ${esc(CFG.dog?.about || '')}</div>
      <div><span class="big">${w ? `${Number(w.weight_kg)} kg` : '–'}</span> <span class="muted small">${w ? `on ${fmtDate(w.entry_date)}` : 'no weight logged'}</span></div></div></div>
    ${v.name ? `<div class="card vet small"><b>Vet:</b> ${esc(v.name)}, ${esc(v.address)} · <a href="tel:${esc(v.tel || v.phone)}">${esc(v.phone)}</a></div>` : ''}
    <details class="card add-health" id="add-health" ${state.addOpen ? 'open' : ''}><summary><b>+ Add entry</b> <span class="muted small">vet visit, weight, symptoms…</span></summary>
      <form id="health-form" novalidate>
        <div class="two"><label class="field">Date <input type="date" name="entry_date" value="${localToday()}" max="${localToday()}" required></label>
          <label class="field">Weight (kg) <input name="weight_kg" type="number" inputmode="decimal" step="0.1" min="1" max="99" placeholder="optional"></label></div>
        <label class="field">What happened <textarea name="text" rows="3" placeholder="e.g. Vet check – all fine. Booster due Aug."></textarea></label>
        <p class="err" id="hf-err" hidden></p>
        <button class="primary wide">Save entry</button></form></details>`;
  h += list.length ? `<h2 class="sec">Health log<small>${list.length} ${list.length === 1 ? 'entry' : 'entries'}</small></h2><div class="list">${list.map((e) => `<div class="item health-entry" data-hid="${e.id}">
      <div class="body"><div class="when">${fmtDate(e.entry_date)}${e.weight_kg != null ? ` <span class="chip who-chip">⚖ ${Number(e.weight_kg)} kg</span>` : ''}</div>
      ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ''}</div></div>`).join('')}</div>` : '<div class="card empty">No entries yet.</div>';
  return h + `<p class="hint">Tap an entry to edit or delete it.</p>`;
}

function renderSupplies() {
  const list = state.db.supplies.slice().sort((a, b) => (a.sort_key ?? 0) - (b.sort_key ?? 0) || a.name.localeCompare(b.name));
  const nLow = list.filter((s) => s.low).length;
  let h = `<div class="toolbar"><button class="primary add" data-add-supply style="flex:1">+ Add supply</button></div>`;
  h += list.length ? `<h2 class="sec">Supplies<small>${nLow ? `${nLow} running low` : 'all stocked'}</small></h2><div class="list">${list.map((s) => `<div class="item ${s.low ? 'low' : ''}" data-sid="${s.id}">
      <div class="body"><div class="name">${esc(s.name)}</div><div class="meta">${s.low ? '<span class="chip s-Due-soon">Running low</span>' : '<span>stocked</span>'}${s.notes ? `<span>${esc(s.notes)}</span>` : ''}</div></div>
      <div class="sw-wrap"><button class="switch" role="switch" aria-checked="${!!s.low}" data-low="${s.id}" aria-label="${esc(s.name)} running low"></button>low</div></div>`).join('')}</div>` : '<div class="card empty">No supplies yet.</div>';
  return h + `<p class="hint">Flip the switch when something is running low; it shows on Today until you flip it back. Tap a name to edit.</p>`;
}

function render() {
  const today = localToday();
  $('#today').textContent = fmtDate(today, { long: true }) + ` · ${VER}` + (be.kind === 'mock' ? ' · local mock' : '') + (state.conn === 'updating' ? ' · updating…' : '');
  $('#account').textContent = '⚙ ' + (be.kind === 'mock' ? 'Mock data' : (be.user?.email || ''));
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
  const views = { today: renderToday, care: renderCare, health: renderHealth, supplies: renderSupplies };
  $('#view').innerHTML = connBanner() + (views[state.tab] || renderToday)();
  const ah = $('#add-health'); if (ah) { ah.addEventListener('toggle', () => (state.addOpen = ah.open)); $('#health-form').onsubmit = saveHealthForm; }
}

function renderLogin(msg = '', sentTo = '') {
  $('#today').textContent = fmtDate(localToday(), { long: true });
  $('#view').innerHTML = `<div class="card login"><h2>Sign in</h2><p class="muted">Use the same email as the Chores app. We'll email you a sign-in link and code – no password needed.</p>
    <form id="login"><input type="email" id="email" required placeholder="you@example.com" autocomplete="email" value="${esc(sentTo)}"><button class="${sentTo ? 'ghost wide' : 'primary'}">${sentTo ? 'Send again' : 'Send sign-in email'}</button></form>
    ${sentTo ? `<form id="code-form"><label class="field">Code from the email <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required placeholder="6-digit code"></label>
      <button class="primary wide">Sign in</button></form><p class="muted small">Or open the link in the email on this device.</p>` : ''}
    <p class="${/Could not|wrong|expired|invalid/i.test(msg) ? 'err' : ''}">${esc(msg)}</p></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault(); const email = $('#email').value.trim();
    try { await be.signIn(email); renderLogin(`Email sent to ${email}.`, email); $('#code')?.focus(); } catch (err) { renderLogin('Could not send: ' + err.message, sentTo); }
  };
  const cf = $('#code-form');
  if (cf) cf.onsubmit = async (e) => {
    e.preventDefault(); const code = $('#code').value.replace(/\s+/g, '');
    try { await be.verifyCode(sentTo, code); location.reload(); }
    catch (err) { renderLogin(/expired|invalid/i.test(err.message) ? 'That code is wrong or has expired – check the latest email, or send a new one.' : 'Could not sign in: ' + err.message, sentTo); }
  };
}

// ---------- health log
async function saveHealthForm(e) {
  e.preventDefault();
  const f = e.target, v = Object.fromEntries(new FormData(f)), err = $('#hf-err');
  const bad = (m) => { err.textContent = m; err.hidden = false; };
  const w = validWeight(v.weight_kg), text = String(v.text || '').trim();
  if (!v.entry_date) return bad('Pick a date.');
  if (v.entry_date > localToday()) return bad('The date can’t be in the future.');
  if (Number.isNaN(w)) return bad('Weight must be a number of kg, e.g. 20.4');
  if (!text && w == null) return bad('Write something or add a weight.');
  if (offlineNow()) return bad(errMsg(new Error('offline')));
  let row;
  try { row = await be.add('health', { entry_date: v.entry_date, text, weight_kg: w }); } catch (ex) { return bad(isNetErr(ex) ? errMsg(ex) : ex.message); }
  state.addOpen = false; await refresh().catch(() => {});
  toast(`Added ${fmtDate(v.entry_date)} entry`, async () => { await be.del('health', row.id); await refresh(); });
}
function openHealth(id) {
  const e = state.db.health.find((x) => x.id === id); if (!e) return;
  const d = $('#edit-sheet');
  d.innerHTML = `<form id="he-form" novalidate><div class="sheet-head"><h2>Health entry</h2><button type="button" class="x" id="he-x" aria-label="Close">✕</button></div>
    <div class="two"><label class="field">Date <input type="date" name="entry_date" value="${e.entry_date}" max="${localToday()}" required></label>
      <label class="field">Weight (kg) <input name="weight_kg" type="number" inputmode="decimal" step="0.1" min="1" max="99" value="${e.weight_kg ?? ''}" placeholder="optional"></label></div>
    <label class="field">What happened <textarea name="text" rows="4">${esc(e.text || '')}</textarea></label>
    <p class="err" id="he-err" hidden></p>
    <div class="row-btns"><button type="button" class="ghost" id="he-del">Delete</button><button class="primary">Save</button></div></form>`;
  const f = $('#he-form', d), err = $('#he-err', d), bad = (m) => { err.textContent = m; err.hidden = false; };
  $('#he-x', d).onclick = () => d.close();
  $('#he-del', d).onclick = async () => {
    if (offlineNow()) return bad(errMsg(new Error('offline')));
    try { await be.del('health', e.id); } catch (ex) { return bad(ex.message); }
    d.close(); await refresh().catch(() => {});
    toast('Entry deleted', async () => { await be.add('health', { entry_date: e.entry_date, text: e.text, weight_kg: e.weight_kg }); await refresh(); });
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault(); const v = Object.fromEntries(new FormData(f)), w = validWeight(v.weight_kg), text = String(v.text || '').trim();
    if (!v.entry_date || v.entry_date > localToday()) return bad('Pick a date (not in the future).');
    if (Number.isNaN(w)) return bad('Weight must be a number of kg, e.g. 20.4');
    if (!text && w == null) return bad('Write something or add a weight.');
    const prev = { entry_date: e.entry_date, text: e.text, weight_kg: e.weight_kg };
    try { await be.patch('health', e.id, { entry_date: v.entry_date, text, weight_kg: w }); } catch (ex) { return bad(isNetErr(ex) ? errMsg(ex) : ex.message); }
    d.close(); await refresh().catch(() => {});
    toast('Saved', async () => { await be.patch('health', e.id, prev); await refresh(); });
  };
  d.showModal();
}

// ---------- supplies
async function toggleLow(id) {
  const s = state.db.supplies.find((x) => x.id === id); if (!s) return;
  if (offlineNow()) return fail(new Error('offline'));
  try { await be.patch('supplies', id, { low: !s.low }); } catch (err) { return fail(err); }
  await refresh().catch(console.error);
  toast(`${s.name} – ${s.low ? 'stocked' : 'running low'}`, async () => { await be.patch('supplies', id, { low: s.low }); await refresh(); });
}
function openSupply(s) {
  const isNew = !s, d = $('#edit-sheet'); s = s || { name: '', notes: '', low: false };
  d.innerHTML = `<form id="su-form" novalidate><div class="sheet-head"><h2>${isNew ? 'Add supply' : 'Edit supply'}</h2><button type="button" class="x" id="su-x" aria-label="Close">✕</button></div>
    <label class="field">Name <input name="name" required value="${esc(s.name)}" placeholder="e.g. Poo bags"></label>
    <label class="field">Notes <input name="notes" value="${esc(s.notes || '')}" placeholder="Optional – brand, size, where to buy"></label>
    <label class="toggle"><input type="checkbox" name="low" ${s.low ? 'checked' : ''}> <span>Running low</span></label>
    <p class="err" id="su-err" hidden></p>
    <div class="row-btns">${isNew ? '<button type="button" class="ghost" id="su-cancel">Cancel</button>' : '<button type="button" class="ghost" id="su-del">Delete</button>'}<button class="primary">${isNew ? 'Add' : 'Save'}</button></div></form>`;
  const f = $('#su-form', d), err = $('#su-err', d), bad = (m) => { err.textContent = m; err.hidden = false; };
  $('#su-x', d).onclick = () => d.close(); if (isNew) $('#su-cancel', d).onclick = () => d.close();
  if (!isNew) $('#su-del', d).onclick = async () => {
    if (!confirm(`Delete “${s.name}” from supplies?`)) return;
    try { await be.del('supplies', s.id); } catch (ex) { return bad(isNetErr(ex) ? errMsg(ex) : ex.message); }
    d.close(); await refresh().catch(() => {});
    toast(`Deleted “${s.name}”`, async () => { await be.add('supplies', { name: s.name, notes: s.notes, low: s.low, sort_key: s.sort_key }); await refresh(); });
  };
  f.onsubmit = async (e) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(f)), name = String(v.name || '').trim();
    if (!name) return bad('A name is needed.');
    if (offlineNow()) return bad(errMsg(new Error('offline')));
    const row = { name, notes: String(v.notes || '').trim() || null, low: !!v.low };
    try {
      if (isNew) await be.add('supplies', { ...row, sort_key: Math.max(0, ...state.db.supplies.map((x) => x.sort_key || 0)) + 1 });
      else await be.patch('supplies', s.id, row);
    } catch (ex) { return bad(isNetErr(ex) ? errMsg(ex) : ex.message); }
    d.close(); await refresh().catch(() => {}); toast(isNew ? `Added “${name}”` : 'Saved');
  };
  d.showModal();
}

// ---------- settings + backup
async function downloadBackup() {
  let db = state.db, note = '';
  try { db = await be.load(); } catch { note = ' (from the copy saved on this device – offline)'; }
  const day = new Date().toLocaleDateString('en-CA');
  const data = { app: 'art', format: 1, exported_at: new Date().toISOString(), account: be.user?.email || null,
    items: db.items, ticks: db.ticks, health: db.health, supplies: db.supplies };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `art-backup-${day}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Backup saved: ${a.download}${note}`);
}
function openSettings() {
  const d = $('#settings'), v = CFG.vet || {};
  d.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>Settings</h2><button value="close" class="x" aria-label="Close">✕</button></div>
    <h3>Ticking as</h3>
    <p class="muted small">Saved on this phone, so Derek's and Peter's ticks show who did it. Optional.</p>
    <div class="seg">${WHO.map((w) => `<button type="button" data-swho="${w}" class="${state.who === w ? 'on' : ''}">${w}</button>`).join('')}<button type="button" data-swho="" class="${state.who ? '' : 'on'}">Nobody</button></div>
    ${v.name ? `<h3>Vet</h3><p class="small vet">${esc(v.name)}<br>${esc(v.address)}<br><a href="tel:${esc(v.tel || v.phone)}">📞 ${esc(v.phone)}</a></p>` : ''}
    <h3>Backup</h3>
    <p class="muted small">A file with all items, ticks, health entries and supplies. Keep it somewhere private.</p>
    <button type="button" class="ghost wide" id="backup">⬇ Download backup</button>
    <h3>Account</h3>
    <p class="muted small">${be.kind === 'mock' ? 'Local mock data (this device only).' : `Signed in as ${esc(be.user?.email || '')} – the same login as the Chores app (signing out here signs out of Chores in this browser too).`}</p>
    <button type="button" class="ghost wide" id="acct">${be.kind === 'mock' ? 'Reset mock data' : 'Sign out'}</button>
    ${CFG.choresUrl ? `<p class="small" style="margin-top:14px"><a href="${esc(CFG.choresUrl)}" style="color:var(--brand)">🧺 Open the Chores app</a></p>` : ''}</form>`;
  d.querySelectorAll('[data-swho]').forEach((b) => (b.onclick = () => { setWho(b.dataset.swho); openSettings(); }));
  $('#backup', d).onclick = downloadBackup;
  $('#acct', d).onclick = async () => {
    if (be.kind === 'mock') { if (confirm('Reset the local mock data back to the seed?')) { be.reset(); location.reload(); } return; }
    if (confirm(`Signed in as ${be.user?.email}. Sign out?`)) { clearCaches(); await be.signOut().catch(() => {}); location.reload(); }
  };
  if (!d.open) d.showModal();
}
function setWho(w) { state.who = w; if (w) localStorage.setItem('art.who', w); else localStorage.removeItem('art.who'); if (state.db) render(); }

// ---------- item sheet (history, notes) + edit
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s;,)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}…</a>`).replace(/\n/g, '<br>');
function openItem(id) {
  const it = itemById(id); if (!it) return;
  const today = localToday(), r = computeItem(it, state.db.ticks, today), retired = it.active === false, daily = isDaily(it);
  const hist = r.history.slice(0, daily ? 14 : 8);
  const weekN = daily ? state.db.ticks.filter((t) => t.item_id === it.id && t.done_on >= monday(today) && t.done_on <= today).length : 0;
  const d = $('#item-sheet');
  d.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>${esc(it.name)}</h2><button value="close" class="x" aria-label="Close">✕</button></div>
    <div class="meta big-meta">${it.category ? `<span>${esc(it.category)}</span>` : ''}<span>${esc(it.frequency)}</span>${statusChip(r.status)}${retired ? '<span class="chip s-No-date">Retired</span>' : ''}</div>
    <dl class="facts">
      ${daily ? `<dt>This week</dt><dd>${weekN} of ${Math.min(7, (new Date(today).getUTCDay() + 6) % 7 + 1)} days (from Monday)</dd>` : `<dt>Next due</dt><dd>${r.next_due ? `${fmtDate(r.next_due, { long: true })}${r.days <= 14 ? ` <span class="muted small">(${esc(dueText(r))})</span>` : ''}` : esc(dueText(r))}
        ${it.due_date && r.next_due === it.due_date ? '<div class="muted small">set date (booked / known) – a tick moves it on</div>' : ''}</dd>`}
      <dt>History</dt><dd>${hist.length ? hist.map((t) => `<div class="hist-line">${fmtDate(t.done_on)}${t.who ? whoChip(t.who) : ''}${t.source === 'assistant' ? ' <span class="muted small">(assistant)</span>' : ''}
        <button type="button" class="link small-link" data-rmtick="${esc(t.id)}" aria-label="Remove the tick on ${fmtDate(t.done_on)}">remove</button></div>`).join('')
        : it.last_done ? `<div class="hist-line">${fmtDate(it.last_done)} <span class="muted small">(typed)</span></div>` : '<span class="muted">never</span>'}
        ${hist.length && it.last_done && !r.history.some((t) => t.done_on === it.last_done) ? `<div class="hist-line muted">${fmtDate(it.last_done)} (typed)</div>` : ''}</dd>
    </dl>
    ${it.notes ? `<div class="howto"><b>Notes</b><p>${linkify(it.notes)}</p></div>` : ''}
    ${retired ? '' : `<div class="row-btns sheet-acts"><button type="button" class="primary" id="is-done">✓ Done today</button><button type="button" class="ghost" id="is-date">Pick a date…</button></div>`}
    <button type="button" class="ghost wide" id="is-edit">✎ Edit${retired ? ' / bring back' : ''}</button></form>`;
  const go = (fn) => async () => { d.close(); await fn(); };
  $('#is-edit', d).onclick = go(() => openEdit(it));
  if (!retired) { $('#is-done', d).onclick = go(() => markDone(it.id, today)); $('#is-date', d).onclick = go(() => pickDate(it)); }
  d.querySelectorAll('[data-rmtick]').forEach((b) => (b.onclick = go(() => removeTick(b.dataset.rmtick))));
  if (!d.open) d.showModal(); d.scrollTop = 0;
}

function openEdit(it) {
  const isNew = !it, d = $('#edit-sheet'), db = state.db;
  it = it || { name: '', category: '', frequency: 'Monthly', notes: '', active: true };
  const shownLast = isNew ? null : lastDone(it, db.ticks);
  const cats = [...new Set(db.items.map((x) => x.category).filter(Boolean))].sort();
  d.innerHTML = `<form id="edit-form" novalidate><div class="sheet-head"><h2>${isNew ? 'Add item' : 'Edit item'}</h2><button type="button" class="x" id="ed-x" aria-label="Close">✕</button></div>
    <label class="field">Name <input name="name" required value="${esc(it.name)}" placeholder="e.g. Nail trim"></label>
    <div class="two"><label class="field">How often <select name="frequency">${Object.keys(FREQUENCIES).map((f) => `<option ${f === it.frequency ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label class="field">Category <input name="category" list="cats-dl" value="${esc(it.category || '')}" placeholder="optional" autocomplete="off"><datalist id="cats-dl">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
    <div class="two"><label class="field">Last done <input name="last_done" type="date" value="${shownLast || ''}" max="${localToday()}"></label>
      <label class="field">Due / booked for <input name="due_date" type="date" value="${it.due_date || ''}"></label></div>
    <p class="muted small">Leave <b>Due / booked for</b> empty to count from Last done. Set it when you know the date (e.g. a vet appointment); ticking it done moves it on.</p>
    <label class="field">Notes <textarea name="notes" rows="3" placeholder="Optional – dose, brand, vet details…">${esc(it.notes || '')}</textarea></label>
    ${isNew ? '' : `<label class="toggle"><input type="checkbox" name="active" ${it.active !== false ? 'checked' : ''}> <span>Active <small class="muted">– untick to retire (hidden, history kept)</small></span></label>`}
    <p class="err" id="ed-err" hidden></p>
    <div class="row-btns"><button type="button" class="ghost" id="ed-cancel">Cancel</button><button class="primary">${isNew ? 'Add item' : 'Save'}</button></div></form>`;
  const f = $('#edit-form', d), err = $('#ed-err', d);
  $('#ed-x', d).onclick = $('#ed-cancel', d).onclick = () => d.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f)), nn = (x) => (String(x ?? '').trim() || null), bad = (m) => { err.textContent = m; err.hidden = false; };
    if (!nn(v.name)) return bad('A name is needed.');
    const newLast = nn(v.last_done);
    if (newLast && newLast > localToday()) return bad('Last done can’t be in the future.');
    const row = { name: nn(v.name), category: nn(v.category), frequency: v.frequency, notes: nn(v.notes), due_date: nn(v.due_date) };
    if (v.frequency === 'Daily') row.due_date = null;
    if (!isNew) row.active = !!v.active;
    if (offlineNow()) return bad(errMsg(new Error('offline')));
    // editing Last done replaces it: drop ticks after the new date (all of them when cleared) so it actually takes effect
    const lastChanged = isNew ? !!newLast : newLast !== shownLast;
    if (lastChanged) row.last_done = newLast;
    const drop = !isNew && lastChanged ? db.ticks.filter((t) => t.item_id === it.id && (newLast == null || t.done_on > newLast)) : [];
    if (drop.length && !confirm(`This removes ${drop.length} later tick${drop.length > 1 ? 's' : ''} from the history. Continue?`)) return;
    const prev = isNew ? null : Object.fromEntries(Object.keys(row).map((k) => [k, it[k] ?? null]));
    let added;
    try {
      if (isNew) added = await be.add('items', { ...row, sort_key: Math.max(0, ...db.items.map((x) => x.sort_key || 0)) + 1 });
      else { await be.patch('items', it.id, row); for (const t of drop) await be.del('ticks', t.id); }
    } catch (ex) { return bad(isNetErr(ex) ? errMsg(ex) : ex.message); }
    d.close(); await refresh().catch(() => {});
    const undo = async () => {
      if (isNew) await be.del('items', added.id);
      else { await be.patch('items', it.id, prev); for (const t of drop) await be.add('ticks', strip(t)); }
      await refresh();
    };
    toast(isNew ? `Added “${row.name}”` : it.active !== false && row.active === false ? `Retired “${row.name}” – hidden from lists` : 'Saved', undo);
  };
  d.showModal(); d.scrollTop = 0;
}
// tap outside a sheet closes it
document.querySelectorAll('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => {
  if (e.target !== d) return; const r = d.getBoundingClientRect();
  if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) d.close();
}));

// ---------- events: tap = done today, long-press / ⋯ = pick a date
let pressTimer = null, longPressed = false;
const itemOf = (el) => itemById(el.closest('.item')?.dataset.id);
const view = $('#view');
view.addEventListener('pointerdown', (e) => {
  longPressed = false; const it = e.target.closest('.item[data-id]'); if (!it) return;
  pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(20); const x = itemOf(it); if (x) pickDate(x); }, 550);
});
['pointerup', 'pointerleave', 'pointercancel', 'scroll'].forEach((ev) => view.addEventListener(ev, () => clearTimeout(pressTimer), true));
view.addEventListener('contextmenu', (e) => { if (e.target.closest('.item[data-id]')) e.preventDefault(); });
view.addEventListener('click', async (e) => {
  if (longPressed) { longPressed = false; return; }
  const b = e.target.closest('button');
  if (!b) {
    if (e.target.closest('a, summary, form, input, textarea')) return;
    const body = e.target.closest('.body'); if (!body) return;
    const host = body.closest('[data-id],[data-tid],[data-hid],[data-sid]'); if (!host) return;
    if (host.dataset.hid) return openHealth(host.dataset.hid);
    if (host.dataset.sid) return openSupply(state.db.supplies.find((s) => s.id === host.dataset.sid));
    return openItem(host.dataset.id || host.dataset.tid);
  }
  if (b.dataset.retry !== undefined) return retry();
  if (b.dataset.relogin !== undefined) { clearCaches(); await be.signOut().catch(() => {}); return location.reload(); }
  if (!state.db) return;   // sign-in / connection screens: their own handlers
  if (b.dataset.who !== undefined) return setWho(b.dataset.who);
  if (b.dataset.goto) { state.tab = b.dataset.goto; render(); return scrollTo(0, 0); }
  if (b.dataset.add !== undefined) return openEdit(null);
  if (b.dataset.addSupply !== undefined) return openSupply(null);
  if (b.dataset.settings !== undefined) return openSettings();
  if (b.dataset.low) return toggleLow(b.dataset.low);
  const it = itemOf(b); if (!it) return;
  if (b.dataset.act === 'done') {
    if (isDaily(it) && state.db.ticks.some((t) => t.item_id === it.id && t.done_on === localToday())) return untickToday(it);
    b.classList.add('done'); return markDone(it.id, localToday());
  }
  if (b.dataset.act === 'date') return pickDate(it);
});
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; $('#toast').hidden = true; if (state.db) render(); scrollTo(0, 0); }));
$('#account').onclick = () => { if (state.db || be.kind === 'mock') openSettings(); };

(async () => {
  try {
    const ok = await be.init();
    be.ready = true;
    if (!ok) return renderLogin();
    // show the last data saved on this device straight away, then refresh in the background
    const cached = readCache();
    if (cached?.db) { state.db = cached.db; state.conn = 'updating'; render(); }
    let rt; be.onChange(() => { clearTimeout(rt); rt = setTimeout(() => refresh().catch(console.error), 250); });
    // phones drop the realtime socket in the background and the date may have changed: reload when shown again
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.db) refresh().catch(console.error); });
    window.addEventListener('online', () => { if (state.conn) retry(); });
    window.addEventListener('offline', () => { if (state.db && be.kind !== 'mock') { state.conn = 'offline'; render(); } });
    await refresh().catch(console.error);   // a failure shows the banner (with cached data) or the full message
  } catch (err) { console.error(err); state.conn = connProblem(err); renderUnreachable(); }
  finally {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  }
})();
