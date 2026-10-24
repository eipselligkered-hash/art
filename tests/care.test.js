import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeItem, computeAll, addMonths, addInterval, planTick, restoreOnRemove, fmtDate, dueText, byStatus, needsAttention, matchByName, validWeight, latestWeight, monday, soonDays } from '../src/care.js';
import { seedRows } from '../src/data.js';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));
const items = seedRows(seed).items.map((i, n) => ({ id: `i${n}`, ...i }));
const byName = (n) => items.find((i) => i.name === n);
const TODAY = '2026-10-24';
const st = (n, ticks = [], today = TODAY) => computeItem(byName(n), ticks, today);

test('seed: what Derek asked for, on Sat 24/10/2026', () => {
  assert.deepEqual(items.filter((i) => i.frequency === 'Daily').map((i) => i.name).sort(), ['Breakfast', 'Dinner', 'Evening walk', 'Morning walk']);
  for (const n of ['Worming tablet', 'Flea tablet', 'Wash']) { const r = st(n); assert.equal(r.next_due, TODAY); assert.equal(r.status, 'Due soon'); assert.equal(dueText(r), 'due today'); }
  const v = st('Vaccine booster'); assert.equal(v.next_due, '2027-08-15'); assert.equal(v.status, 'OK'); assert.equal(fmtDate(v.next_due), 'Sun 15/08/2027');
  const t = st('Teeth cleaning at vet'); assert.equal(t.status, 'To book'); assert.equal(t.next_due, null);
  assert.deepEqual(seed.supplies.map((s) => s.name), ['Food', 'Treats', 'Flea tablets', 'Worming tablets']);
  assert.deepEqual(seed.health, [{ entry_date: '2026-10-24', text: 'Weight about 20 kg', weight_kg: 20 }]);
  const due = computeAll(items, [], TODAY).filter((r) => r.item.frequency !== 'Daily' && needsAttention(r)).sort(byStatus).map((r) => r.item.name);
  assert.deepEqual(due, ['Worming tablet', 'Flea tablet', 'Wash', 'Teeth cleaning at vet']);
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
  assert.equal(m('booster'), 'Vaccine booster'); assert.equal(m('teeth'), 'Teeth cleaning at vet'); assert.equal(m('bath'), 'Wash');
  assert.equal(m('morning walk'), 'Morning walk'); assert.equal(m('dinnr'), 'Dinner');
  assert.ok(matchByName('walk', items).candidates.length === 2);
});
