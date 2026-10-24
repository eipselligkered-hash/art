import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(root + p, 'utf8');

test('service worker caches files that exist', () => {
  const shell = JSON.parse(read('sw.js').match(/const SHELL = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const f of shell) if (f !== './') assert.ok(fs.existsSync(root + f), `missing ${f}`);
});

test('no secrets: config has only the anon key, no service_role anywhere in tracked files', () => {
  const cfg = read('config.js'); const jwt = cfg.match(/supabaseAnonKey: '([^']+)'/)[1];
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).role, 'anon');
  let files; try { files = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { files = []; }
  if (!files.length) files = ['config.js', 'index.html', 'src/app.js', 'src/data.js', 'src/care.js', 'scripts/assistant_cli/cli.mjs', 'README.md'];
  for (const f of files) {
    if (f.startsWith('vendor/') || /\.(png|jpg)$/.test(f) || !fs.existsSync(root + f)) continue;
    const s = read(f);
    for (const m of s.matchAll(/eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+/g)) assert.notEqual(JSON.parse(Buffer.from(m[1], 'base64url')).role, 'service_role', `service key in ${f}`);
    if (process.env.SUPABASE_SERVICE_KEY) assert.ok(!s.includes(process.env.SUPABASE_SERVICE_KEY), `service key in ${f}`);
  }
});

test('schema: art_ tables only, RLS on all of them', () => {
  const sql = read('supabase/schema.sql');
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['art_items', 'art_ticks', 'art_health', 'art_supplies']);
  for (const t of tables) assert.match(sql, new RegExp(`alter table public\\.${t}\\s+enable row level security`));
  assert.doesNotMatch(sql, /drop table|public\.tasks|public\.completions/);
});

test('index loads versioned assets and the four tabs', () => {
  const html = read('index.html');
  for (const t of ['today', 'care', 'health', 'supplies']) assert.match(html, new RegExp(`data-tab="${t}"`));
  assert.match(html, /src\/app\.js\?v=2/);
});
