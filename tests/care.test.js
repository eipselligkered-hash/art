import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { groupByCategory, normCategory, CATEGORY_ORDER, computeItem, computeAll, addMonths, addInterval, planTick, restoreOnRemove, fmtDate, dueText, byStatus, needsAttention, matchByName, validWeight, latestWeight, monday, soonDays } from '../src/care.js';
import { seedRows, planSeedSync, syncSeed } from '../src/data.js';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));
const items = seedRows(seed).items.map((i, n) => ({ id: `i${n}`, ...i }));
const byName = (n) => items.find((i) => i.name === n);
const TODAY = '2026-10-24';
const st = (n, ticks = [], today = TODAY) => computeItem(byName(n), ticks, today);

test('seed: what Derek asked for, on Sat 24/10/2026', () => {
  assert.deepEqual(items.filter((i) => i.frequency === 'Daily').map((i) => i.name).sort(), ['Breakfast', 'Dinner', 'Evening walk', 'Fresh water check', 'Morning walk']);
  assert.equal(items.length, 25);
  for (const n of ['Worming tablet', 'Flea tablet', 'Wash']) { const r = st(n); assert.equal(r.next_due, TODAY); assert.equal(r.status, 'Due soon'); assert.equal(dueText(r), 'due today'); }
  const v = st('Vaccine booster'); assert.equal(v.next_due, '2027-08-15'); assert.equal(v.status, 'OK'); assert.equal(fmtDate(v.next_due), 'Sun 15/08/2027');
  const t = st('Teeth cleaning at vet'); assert.equal(t.status, 'To book'); assert.equal(t.next_due, null);
  assert.deepEqual(seed.supplies.map((s) => s.name), ['Food', 'Treats', 'Flea tablets', 'Worming tablets', 'Poo bags', 'Shampoo', 'Dental chews']);
  assert.deepEqual(seed.health, [{ entry_date: '2026-10-24', text: 'Weight about 20 kg', weight_kg: 20 }]);
  const due = computeAll(items, [], TODAY).filter((r) => r.item.frequency !== 'Daily' && needsAttention(r)).sort(byStatus).map((r) => r.item.name);
  assert.deepEqual(due.slice(0, 3), ['Worming tablet', 'Flea tablet', 'Wash']);
  assert.ok(due.includes('Teeth cleaning at vet') && due.includes('Kennel cough vaccine') && due.includes('Dog licence renewal'));
  assert.ok(!due.includes('Vaccine booster') && !due.includes('Annual check-up') && !due.includes('Weigh-in') && !due.includes('Christmas food safety'));
});

test('status moves from Due soon to Overdue, vaccine becomes Due soon a month ahead', () => {
  assert.equal(st('Flea tablet', [], '2026-10-25').status, 'Overdue');
  assert.equal(dueText(st('Flea tablet', [], '2026-10-27')), '3 days overdue');
  assert.equal(st('Vaccine booster', [], '2027-07-16').status, 'Due soon');
  assert.equal(st('Vaccine booster', [], '2027-07-15').status, 'OK');
  assert.equal(st('Vaccine booster', [], '2027-08-16').status, 'Overdue');
  assert.equal(soonDays('Monthly'), 7);
});

test('ticking a monthly item: next due one calendar month on, due date used up and restorable', () => {
  const it = byName('Worming tablet'); const p = planTick(it, [], TODAY);
  assert.equal(p.duplicate, false); assert.deepEqual(p.patch, { due_date: null }); assert.equal(p.cleared_due, TODAY);
  const tick = { id: 't1', item_id: it.id, done_on: TODAY, cleared_due: p.cleared_due };
  const after = computeItem({ ...it, ...p.patch }, [tick], TODAY);
  assert.equal(after.next_due, '2026-11-24'); assert.equal(after.status, 'OK'); assert.equal(after.last, TODAY);
  assert.equal(planTick({ ...it, ...p.patch }, [tick], TODAY).duplicate, true);
  assert.deepEqual(restoreOnRemove({ ...it, due_date: null }, tick), { due_date: TODAY });
  assert.equal(restoreOnRemove({ ...it, due_date: '2026-12-01' }, tick), null);   // a newer booked date wins
  // a tick on/after a due date also moves it on even if the date wasn't cleared (e.g. ticked from another device)
  assert.equal(computeItem(it, [{ item_id: it.id, done_on: '2026-10-26' }], '2026-10-26').next_due, '2026-11-26');
  // ticked early with a booked date cleared: counts from the tick
  assert.equal(computeItem({ ...it, due_date: null }, [{ item_id: it.id, done_on: '2026-10-20' }], TODAY).next_due, '2026-11-20');
});

test('calendar months clamp to month end; yearly and day intervals', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addInterval('2026-08-15', 'Yearly'), '2027-08-15');
  assert.equal(addInterval('2026-10-24', 'Fortnightly'), '2026-11-07');
  assert.equal(addInterval('2026-10-24', 'One-off'), null);
});

test('daily items: done today or to do, ticks from other days do not count', () => {
  const it = byName('Morning walk');
  assert.equal(computeItem(it, [], TODAY).status, 'To do');
  const r = computeItem(it, [{ item_id: it.id, done_on: TODAY, who: 'Derek' }, { item_id: it.id, done_on: '2026-10-23' }], TODAY);
  assert.equal(r.status, 'Done'); assert.equal(r.today_ticks[0].who, 'Derek'); assert.equal(r.history.length, 2);
  assert.equal(computeItem(it, [{ item_id: it.id, done_on: '2026-10-23' }], TODAY).status, 'To do');
  assert.deepEqual(planTick(it, [], TODAY).patch, {});
});

test('one-off: booked date gives a status, a tick makes it Done', () => {
  const it = { ...byName('Teeth cleaning at vet'), due_date: '2026-11-03' };
  assert.equal(computeItem(it, [], TODAY).status, 'OK');
  assert.equal(computeItem(it, [], '2026-10-30').status, 'Due soon');
  const r = computeItem(it, [{ item_id: it.id, done_on: '2026-11-03' }], '2026-11-03'); assert.equal(r.status, 'Done'); assert.equal(dueText(r), 'done Tue 03/11/2026');
});

test('retired items are left out; recurring with no dates shows No date', () => {
  assert.equal(computeAll([{ ...byName('Wash'), active: false }], [], TODAY).length, 0);
  const r = computeItem({ id: 'x', name: 'Nails', frequency: 'Monthly' }, [], TODAY); assert.equal(r.status, 'No date'); assert.ok(needsAttention(r));
});

test('formatting: dd/mm/yyyy, week starts Monday', () => {
  assert.equal(fmtDate('2026-10-24'), 'Sat 24/10/2026');
  assert.equal(fmtDate('2026-10-24', { long: true }), 'Saturday 24/10/2026');
  assert.equal(fmtDate('2026-10-24', { short: true }), 'Sat 24/10');
  assert.equal(monday('2026-10-24'), '2026-10-19'); assert.equal(monday('2026-10-19'), '2026-10-19'); assert.equal(monday('2026-10-25'), '2026-10-19');
});

test('weights and health log helpers', () => {
  assert.equal(validWeight('20,4'), 20.4); assert.equal(validWeight(''), null); assert.ok(Number.isNaN(validWeight('heavy'))); assert.ok(Number.isNaN(validWeight('250')));
  assert.equal(latestWeight([{ entry_date: '2026-10-01', weight_kg: 19.5 }, { entry_date: '2026-10-24', weight_kg: 20 }, { entry_date: '2026-10-25', weight_kg: null }]).weight_kg, 20);
});

test('fuzzy names for the assistant', () => {
  const m = (q) => matchByName(q, items).match?.name;
  assert.equal(m('worming'), 'Worming tablet'); assert.equal(m('wormer'), 'Worming tablet'); assert.equal(m('flea'), 'Flea tablet');
  assert.equal(m('booster'), 'Vaccine booster'); assert.equal(m('teeth cleaning'), 'Teeth cleaning at vet'); assert.ok(matchByName('teeth', items).candidates.length === 2); assert.equal(m('nail'), 'Nail trim'); assert.equal(m('kennel cough'), 'Kennel cough vaccine'); assert.equal(m('bath'), 'Wash');
  assert.equal(m('morning walk'), 'Morning walk'); assert.equal(m('dinnr'), 'Dinner');
  assert.ok(matchByName('walk', items).candidates.length === 2);
});

test('v2 seed items: frequencies, dates and notes as asked (24/10/2026)', () => {
  const r = (n, today = TODAY) => st(n, [], today);
  assert.equal(r('Nail trim').status, 'Due soon'); assert.equal(byName('Nail trim').frequency, 'Every 4 weeks');
  assert.equal(computeItem(byName('Nail trim'), [{ item_id: byName('Nail trim').id, done_on: TODAY }], TODAY).next_due, '2026-11-21');
  assert.equal(computeItem(byName('Teeth brushing'), [{ item_id: byName('Teeth brushing').id, done_on: TODAY }], TODAY).next_due, '2026-10-27');
  assert.equal(r('Ear check').next_due, TODAY); assert.equal(byName('Ear check').frequency, 'Fortnightly');
  assert.equal(r('Weigh-in').next_due, '2026-11-24'); assert.match(byName('Weigh-in').notes, /24\/10\/2026/);
  assert.equal(r('Annual check-up').next_due, '2027-08-15');
  assert.equal(r('Kennel cough vaccine').status, 'To book');
  assert.equal(r('Dog licence renewal').status, 'No date'); assert.match(byName('Dog licence renewal').notes, /licences\.ie/);
  assert.equal(r('Halloween fireworks plan').next_due, '2026-10-29'); assert.equal(r('Winter coat out').next_due, '2026-11-01'); assert.equal(r('Christmas food safety').next_due, '2026-12-15');
  assert.match(byName('Flea tablet').notes, /NexGard or Bravecto/);
  assert.ok(!items.some((i) => ['Treatment', 'Vet'].includes(i.category)));
});

test('Care sections: fixed order, renames, others after, uncategorised last', () => {
  const rows = [{ item: { name: 'x', category: 'Seasonal' } }, { item: { name: 'y', category: 'Toys' } }, { item: { name: 'z' } }, { item: { name: 'w', category: 'Vet' } },
    { item: { name: 'v', category: 'Treatment' } }, { item: { name: 'u', category: 'Daily', frequency: 'Daily' } }, { item: { name: 't', category: 'home & admin' } }, { item: { name: 's', category: 'Grooming' } }];
  assert.deepEqual(groupByCategory(rows).map(([c]) => c), ['Daily', 'Treatments', 'Grooming', 'Vet & health', 'Home & admin', 'Seasonal', 'Toys', 'Other']);
  assert.equal(normCategory({ frequency: 'Daily' }), 'Daily');
  const seeded = groupByCategory(computeAll(items, [], TODAY)).map(([c]) => c);
  assert.deepEqual(seeded, CATEGORY_ORDER);
});

test('seed sync: idempotent by name, renames old categories, adds the flea note once, health only when fresh', async () => {
  const old = { items: [{ id: 'a', name: 'Flea tablet', category: 'Treatment', notes: 'Due now (October 2026).' }, { id: 'b', name: 'vaccine booster', category: 'Vet' }, { id: 'c', name: 'Worming tablet', category: 'Treatment' }],
    supplies: [{ id: 's', name: 'Food' }], health: [{ id: 'h', entry_date: TODAY, text: 'Weight about 20 kg' }], ticks: [] };
  const p = planSeedSync(old, seed);
  assert.equal(p.items.length, 22); assert.ok(!p.items.some((i) => /vaccine booster|flea tablet/i.test(i.name)));
  assert.equal(p.supplies.length, 6); assert.equal(p.health.length, 0);
  assert.deepEqual(p.patches.filter((x) => x.patch.category).map((x) => [x.id, x.patch.category]), [['a', 'Treatments'], ['b', 'Vet & health'], ['c', 'Treatments']]);
  assert.match(p.patches.find((x) => x.patch.notes).patch.notes, /^Due now \(October 2026\)\. Ask the vet about a combined flea and tick tablet/);
  // apply with a tiny in-memory store that rejects the new frequencies (database before migration 002)
  const db = structuredClone(old); let n = 0;
  const store = { async add(t, row) { if (['A few times a week', 'Every 4 weeks'].includes(row.frequency)) throw new Error('violates check constraint "art_items_frequency_check"'); db[t].push({ id: `n${++n}`, ...row }); },
    async patch(t, id, patch) { Object.assign(db[t].find((x) => x.id === id), patch); } };
  const r1 = await syncSeed(store, db, seed);
  assert.equal(r1.complete, false); assert.deepEqual(r1.skipped.map((x) => x.name).sort(), ['Nail trim', 'Teeth brushing']); assert.equal(db.items.length, 23);
  const r2 = await syncSeed(store, db, seed);   // second run: only the two blocked items are tried again
  assert.equal(r2.patched, 0); assert.equal(r2.items.length, 0); assert.equal(r2.skipped.length, 2);
  delete store.add; store.add = async (t, row) => { db[t].push({ id: `n${++n}`, ...row }); };
  const r3 = await syncSeed(store, db, seed); assert.ok(r3.complete); assert.equal(db.items.length, 25);
  assert.equal(planSeedSync(db, seed).items.length + planSeedSync(db, seed).patches.length, 0);
  const fresh = planSeedSync({ items: [], supplies: [], health: [], ticks: [] }, seed); assert.equal(fresh.items.length, 25); assert.equal(fresh.health.length, 1);
});
