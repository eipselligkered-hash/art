import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { startFake } from './fake_postgrest.mjs';
import { seedRows } from '../src/data.js';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));
const OWNER = '00000000-0000-0000-0000-00000000beef', OTHER = '00000000-0000-0000-0000-00000000cafe';
const run = (args, env = {}) => new Promise((ok, ko) => execFile('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { env: { ...process.env, ART_MOCK: '', ART_OWNER: '', ...env } },
  (e, so, se) => (e && e.code !== 2 ? ko(new Error(se || e.message)) : ok(so))));

function fakeDb() {
  const s = seedRows(seed); let n = 0; const own = (o) => (r) => ({ id: `row-${++n}`, owner_id: o, ...r });
  return { tasks: [{ id: 'chore', owner_id: OWNER }], art_items: [...s.items.map(own(OWNER)), { ...s.items[4], id: 'other-item', owner_id: OTHER }].filter((r) => r.owner_id === OWNER),
    art_ticks: [], art_health: s.health.map(own(OWNER)), art_supplies: s.supplies.map(own(OWNER)) };
}

test('CLI against a fake Supabase REST API: due, done, undo, low, log', async () => {
  const f = await startFake(fakeDb()); const env = { SUPABASE_URL: f.url, SUPABASE_SERVICE_KEY: 'test-service-key' };
  try {
    const due = JSON.parse(await run(['due', '--today', '2026-10-24', '--json'], env));
    assert.deepEqual(due.due.slice(0, 3).map((r) => [r.name, r.status]), [['Worming tablet', 'Due soon'], ['Flea tablet', 'Due soon'], ['Wash', 'Due soon']]);
    assert.equal(due.daily.length, 5);
    assert.equal(due.next.name, 'Weigh-in'); assert.equal(due.next.next_due, '2026-11-24'); assert.equal(due.weight.weight_kg, 20);
    const d = await run(['done', 'worming', 'morning walk', '--who', 'peter', '--today', '2026-10-24'], env);
    assert.match(d, /Worming tablet done Sat 24\/10\/2026 \(Peter\).*next due Tue 24\/11\/2026/); assert.match(d, /Morning walk done/);
    assert.equal(f.db.art_ticks.length, 2); assert.equal(f.db.art_ticks[0].owner_id, OWNER); assert.equal(f.db.art_ticks[0].source, 'assistant'); assert.equal(f.db.art_ticks[0].who, 'Peter');
    assert.equal(f.db.art_items.find((i) => i.name === 'Worming tablet').due_date, null);
    assert.match(await run(['done', 'worming', '--today', '2026-10-24'], env), /already marked done/);
    const u = await run(['undo', 'worming', '--today', '2026-10-24'], env);
    assert.match(u, /undone.*due today/); assert.equal(f.db.art_ticks.length, 1); assert.equal(f.db.art_items.find((i) => i.name === 'Worming tablet').due_date, '2026-10-24');
    assert.match(await run(['low', 'flea tablets'], env), /Flea tablets → running low/);
    assert.equal(f.db.art_supplies.find((s) => s.name === 'Flea tablets').low, true);
    assert.match(await run(['due', '--today', '2026-10-24'], env), /Running low: Flea tablets/);
    assert.match(await run(['log', 'Vet check, all fine', '--weight', '20.4', '--today', '2026-10-24'], env), /added Sat 24\/10\/2026: Vet check, all fine \(20.4 kg\)/);
    assert.equal(f.db.art_health.length, 2);
    assert.match(await run(['done', 'walk', '--today', '2026-10-24'], env), /ambiguous.*\n.*Morning walk/);
    assert.ok(f.log.every((l) => !l.startsWith('GET /rest/v1/art_') || l.includes('owner_id') || l.includes('select=owner_id')));
  } finally { f.close(); }
});

test('CLI seed uses the Chores owner when Art has no data yet', async () => {
  const f = await startFake({ tasks: [{ id: 't', owner_id: OWNER }], art_items: [], art_ticks: [], art_health: [], art_supplies: [] });
  const env = { SUPABASE_URL: f.url, SUPABASE_SERVICE_KEY: 'test-service-key' };
  try {
    assert.match(await run(['due'], env).catch((e) => e.message), /No Art data yet/);
    assert.match(await run(['sync'], env), /added 25 items.*7 supplies.*1 health entries/);
    assert.ok(f.db.art_items.every((i) => i.owner_id === OWNER));
    assert.match(await run(['seed'], env), /Nothing to add/);
  } finally { f.close(); }
});

test('CLI against the local mock file', async () => {
  const file = os.tmpdir() + `/art_mock_${process.pid}.json`; fs.rmSync(file, { force: true });
  const o = await run(['done', 'flea', '--mock', file, '--today', '2026-10-24', '--date', '2026-10-23']);
  assert.match(o, /Flea tablet done Fri 23\/10\/2026.*next due Mon 23\/11\/2026/);
  assert.equal(JSON.parse(fs.readFileSync(file)).ticks.length, 1);
  assert.match(await run(['done', 'flea', '--mock', file, '--today', '2026-10-24', '--date', '2026-10-30']).catch((e) => e.message), /in the future/);
  fs.rmSync(file);
});

test('CLI sync tops up an old (v1) account: new items/supplies by name + category renames', async () => {
  const s = seedRows(seed); let n = 0; const own = (r) => ({ id: `row-${++n}`, owner_id: OWNER, ...r });
  const v1 = s.items.slice(0, 9).map((i) => ({ ...i, category: { Treatments: 'Treatment', 'Vet & health': 'Vet' }[i.category] || i.category }));
  const f = await startFake({ tasks: [], art_items: v1.map(own), art_ticks: [], art_health: s.health.map(own), art_supplies: s.supplies.slice(0, 4).map(own) });
  const env = { SUPABASE_URL: f.url, SUPABASE_SERVICE_KEY: 'test-service-key' };
  try {
    assert.match(await run(['sync', '--dry-run'], env), /add 16 items.*3 supplies, 0 health entries; 4 updates/);
    assert.equal(f.db.art_items.length, 9);
    assert.match(await run(['sync'], env), /added 16 items.*3 supplies \(Poo bags, Shampoo, Dental chews\), 0 health entries; 4 updates/);
    assert.equal(f.db.art_items.length, 25); assert.ok(f.db.art_items.every((i) => i.owner_id === OWNER && !['Treatment', 'Vet'].includes(i.category)));
    assert.match(f.db.art_items.find((i) => i.name === 'Flea tablet').notes, /NexGard/);
    assert.match(await run(['sync'], env), /Nothing to add/);
  } finally { f.close(); }
});
