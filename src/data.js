// Data layer with two interchangeable backends (same pattern as the Chores app):
//   MockBackend      - localStorage, seeded from data/seed.json (works offline, no account)
//   SupabaseBackend  - vendored supabase-js v2, email magic link + code, RLS-protected art_* tables (same project + login as Chores)
// Both expose: init(), user, kind, signIn(email), verifyCode(email, code), signOut(), load() -> {items, ticks, health, supplies},
//              add(table, row), patch(table, id, patch), del(table, id), seedIfEmpty(seed), onChange(cb)
// Tables (logical names): items, ticks, health, supplies  ->  Supabase: art_items, art_ticks, art_health, art_supplies
export const TABLES = { items: 'art_items', ticks: 'art_ticks', health: 'art_health', supplies: 'art_supplies' };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const now = () => new Date().toISOString();
const dupMsg = (table) => (table === 'items' ? 'There is already an item with that name.' : table === 'supplies' ? 'There is already a supply with that name.' : table === 'ticks' ? 'Already ticked that day.' : 'Duplicate');

/** Rows to insert for a fresh account (ids/timestamps filled in by the caller or the database). */
export function seedRows(seed) {
  return {
    items: seed.items.map((i) => ({ active: true, due_date: null, last_done: null, notes: null, category: null, ...i })),
    supplies: seed.supplies.map((s) => ({ low: false, notes: null, ...s })),
    health: seed.health.map((h) => ({ weight_kg: null, ...h })),
  };
}
async function fetchSeed() { return (await fetch(new URL('../data/seed.json?v=1', import.meta.url))).json(); }

export class MockBackend {
  constructor(key = 'art.mock.v1') { this.key = key; this.kind = 'mock'; this.user = { email: 'local mock (this device only)' }; this.cbs = []; }
  async init() {
    const raw = localStorage.getItem(this.key);
    if (raw) this.db = JSON.parse(raw);
    else {
      const s = seedRows(await fetchSeed()), stamp = (r) => ({ id: uid(), created_at: now(), ...r });
      this.db = { items: s.items.map(stamp), ticks: [], health: s.health.map(stamp), supplies: s.supplies.map(stamp) };
      this.save();
    }
    window.addEventListener('storage', (e) => { if (e.key === this.key && e.newValue) { this.db = JSON.parse(e.newValue); this.cbs.forEach((f) => f()); } });
    return true;
  }
  save() { localStorage.setItem(this.key, JSON.stringify(this.db)); }
  async signIn() {} async verifyCode() {} async signOut() {}
  async load() { return structuredClone(this.db); }
  async seedIfEmpty() { return false; }
  async add(table, row) {
    const t = this.db[table];
    if ((table === 'items' || table === 'supplies') && t.some((x) => x.name.toLowerCase() === String(row.name).toLowerCase())) throw new Error(dupMsg(table));
    if (table === 'ticks' && t.some((x) => x.item_id === row.item_id && x.done_on === row.done_on)) throw new Error(dupMsg(table));
    const r = { id: uid(), created_at: now(), ...row }; t.push(r); this.save(); return structuredClone(r);
  }
  async patch(table, id, patch) {
    const r = this.db[table].find((x) => x.id === id); if (!r) throw new Error('Not found');
    if (patch.name && (table === 'items' || table === 'supplies') && this.db[table].some((x) => x.id !== id && x.name.toLowerCase() === patch.name.toLowerCase())) throw new Error(dupMsg(table));
    Object.assign(r, patch, { updated_at: now() }); this.save(); return structuredClone(r);
  }
  async del(table, id) { this.db[table] = this.db[table].filter((x) => x.id !== id); if (table === 'items') this.db.ticks = this.db.ticks.filter((t) => t.item_id !== id); this.save(); }
  onChange(cb) { this.cbs.push(cb); }
  reset() { localStorage.removeItem(this.key); }
}

export class SupabaseBackend {
  constructor(url, anonKey) { this.url = url; this.anonKey = anonKey; this.kind = 'supabase'; this.user = null; }
  async init() {
    const { createClient } = await loadSupabase();
    this.sb = createClient(this.url, this.anonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
    // also accept links that carry tokens in the #hash (e.g. a sign-in link made by the assistant)
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('access_token') && h.get('refresh_token')) {
      await this.sb.auth.setSession({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token') });
      history.replaceState(null, '', location.pathname + location.search);
    }
    const { data, error } = await this.sb.auth.getSession();
    this.user = data.session?.user || null;
    // offline with an expired access token: carry on with cached data; the next online load refreshes the token
    if (!this.user && error) this.user = savedSessionUser(this.url);
    this.offlineSession = !data.session && !!this.user;
    this.sb.auth.onAuthStateChange((_e, s) => { const was = !!this.user; this.user = s?.user || null; if (was !== !!this.user) location.reload(); });
    return !!this.user;
  }
  async signIn(email) {
    const redirect = location.origin + location.pathname;
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
    if (error) throw error;
  }
  async verifyCode(email, token) { const { error } = await this.sb.auth.verifyOtp({ email, token, type: 'email' }); if (error) throw error; }
  async signOut() { await this.sb.auth.signOut(); }
  async q(p, table) {
    const { data, error } = await p;
    if (error) {
      if (/art_\w+/.test(error.message || '') && /schema cache|does not exist|relation/i.test(error.message || '')) throw new Error('The Art tables are not set up yet – run supabase/schema.sql in the Supabase SQL Editor.');
      if (/duplicate key|unique/i.test(error.message || '')) throw new Error(dupMsg(table));
      throw error;
    }
    return data;
  }
  async load() {
    const [items, ticks, health, supplies] = await Promise.all([
      this.q(this.sb.from(TABLES.items).select('*').order('sort_key')),
      this.q(this.sb.from(TABLES.ticks).select('*').order('done_on')),
      this.q(this.sb.from(TABLES.health).select('*').order('entry_date', { ascending: false })),
      this.q(this.sb.from(TABLES.supplies).select('*').order('sort_key')),
    ]);
    return { items, ticks, health, supplies };
  }
  /** First sign-in: create Art's starting list for this account (unique names make a double run harmless). */
  async seedIfEmpty(db) {
    if (db.items.length || db.supplies.length || db.health.length) return false;
    const s = seedRows(await fetchSeed()), owner_id = this.user?.id, own = (r) => ({ ...r, owner_id });
    await this.q(this.sb.from(TABLES.items).upsert(s.items.map(own), { onConflict: 'owner_id,name', ignoreDuplicates: true }), 'items');
    await this.q(this.sb.from(TABLES.supplies).upsert(s.supplies.map(own), { onConflict: 'owner_id,name', ignoreDuplicates: true }), 'supplies');
    const { count } = await this.sb.from(TABLES.health).select('id', { count: 'exact', head: true });
    if (!count) await this.q(this.sb.from(TABLES.health).insert(s.health.map(own)), 'health');
    return true;
  }
  async add(table, row) { return this.q(this.sb.from(TABLES[table]).insert({ owner_id: this.user?.id, ...row }).select().single(), table); }
  async patch(table, id, patch) { return this.q(this.sb.from(TABLES[table]).update(patch).eq('id', id).select().single(), table); }
  async del(table, id) { await this.q(this.sb.from(TABLES[table]).delete().eq('id', id), table); }
  onChange(cb) { this.sb.channel('art').on('postgres_changes', { event: '*', schema: 'public' }, (p) => { if (String(p.table || '').startsWith('art_')) cb(); }).subscribe(); }
}

// supabase-js v2 UMD build, vendored (vendor/supabase.js) so it is cached by the service worker and works offline
function loadSupabase() {
  if (window.supabase?.createClient) return Promise.resolve(window.supabase);
  return new Promise((ok, ko) => {
    const s = document.createElement('script'); s.src = new URL('../vendor/supabase.js?v=1', import.meta.url).href;
    s.onload = () => (window.supabase?.createClient ? ok(window.supabase) : ko(new Error('supabase-js did not load')));
    s.onerror = () => ko(new Error('Could not load supabase-js (offline?)'));
    document.head.appendChild(s);
  });
}
function savedSessionUser(url) {
  try {
    const ref = new URL(url).hostname.split('.')[0];
    const v = JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`) || 'null');
    return v?.user || v?.currentSession?.user || null;
  } catch { return null; }
}

export function makeBackend(cfg = window.ART_CONFIG || {}) {
  const filled = cfg.supabaseUrl && !cfg.supabaseUrl.includes('YOUR-') && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes('YOUR-');
  const mode = new URLSearchParams(location.search).get('backend') || cfg.backend || 'auto';
  if (mode === 'supabase' || (mode === 'auto' && filled)) return new SupabaseBackend(cfg.supabaseUrl, cfg.supabaseAnonKey);
  return new MockBackend();
}
