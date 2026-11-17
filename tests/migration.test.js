import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readSqliteSnapshot, importSnapshot, validateSnapshot } from '../scripts/migrate-sqlite.js';
import { MemoryStore } from './support/memory-store.js';
import { approximateMealRate, calculateBalances } from '../public/model.js';

test('legacy SQLite snapshots preserve IDs, guest portions and source database', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meal-manage-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'old.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, joined TEXT, active INTEGER);
    CREATE TABLE deposits (id INTEGER PRIMARY KEY, memberId INTEGER, amount INTEGER, date TEXT);
    CREATE TABLE groceries (id INTEGER PRIMARY KEY, memberId INTEGER, amount INTEGER, note TEXT, date TEXT);
    CREATE TABLE meals (id INTEGER PRIMARY KEY, date TEXT, slot TEXT, dish TEXT);
    CREATE TABLE attendees (mealId INTEGER, memberId INTEGER, guests INTEGER);
    INSERT INTO members VALUES (5, 'Rahim', '', '2026-11-17', 0);
    INSERT INTO deposits VALUES (7, 5, 300000, '2026-11-17T12:00:00.000Z');
    INSERT INTO groceries VALUES (9, 5, 120000, 'Rice', '2026-11-17T12:00:00.000Z');
    INSERT INTO meals VALUES (3, '2026-11-17', 'lunch', 'Rice');
    INSERT INTO attendees VALUES (3, 5, 2);
  `);
  db.close();
  const snapshot = readSqliteSnapshot(source);
  assert.equal(snapshot.members[0].active, false);
  assert.equal(snapshot.meals[0].approximateCost, null);
  assert.deepEqual(snapshot.meals[0].attendees, [{ memberId: 5, guests: 2, quantity: 1 }]);
  const store = new MemoryStore();
  const imported = await importSnapshot(store, snapshot);
  assert.deepEqual(calculateBalances(imported), calculateBalances(snapshot));
  assert.deepEqual(readSqliteSnapshot(source), snapshot);
  await assert.rejects(importSnapshot(store, snapshot), /not empty/);
  assert.deepEqual(await store.read(), imported);
  const next = await store.update((data, allocateId) => data.members.push({ id: allocateId('members'), name: 'Karim', phone: '', joined: '2026-11-17', active: true }));
  assert.equal(next.members[1].id, 6);
});

test('import validation rejects orphaned references and duplicate meal slots', () => {
  const source = { members: [{ id: 1, name: 'Rahim', phone: '', joined: '2026-11-17', active: true }], deposits: [], groceries: [], meals: [{ id: 1, date: '2026-11-17', slot: 'lunch', dish: 'Rice', approximateCost: 43000, attendees: [{ memberId: 1, quantity: 20, guests: 20 }] }] };
  assert.equal(validateSnapshot(source), source);
  assert.equal(approximateMealRate(source.meals[0]), 1075);
  assert.throws(() => validateSnapshot({ ...source, deposits: [{ id: 1, memberId: 999, amount: 100, date: '2026-11-17' }] }), /missing member/);
  assert.throws(() => validateSnapshot({ ...source, meals: [...source.meals, { ...source.meals[0], id: 2 }] }), /duplicate meal/);
});
