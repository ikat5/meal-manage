import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MongoStore, collections, emptyData } from '../storage/mongo-store.js';
import { slots } from '../public/model.js';

export function validateSnapshot(data) {
  const ids = {};
  for (const name of collections) {
    if (!Array.isArray(data[name])) throw new Error(`Missing ${name} collection.`);
    ids[name] = new Set();
    for (const record of data[name]) {
      if (!Number.isSafeInteger(record.id) || record.id < 1 || ids[name].has(record.id)) throw new Error(`Invalid or duplicate ${name} ID.`);
      ids[name].add(record.id);
    }
  }
  const dates = new Set();
  for (const member of data.members) {
    if (typeof member.name !== 'string' || !member.name.trim() || member.name.length > 80 || typeof member.phone !== 'string' || typeof member.active !== 'boolean' || !Number.isFinite(Date.parse(member.joined))) throw new Error('Invalid member in source.');
  }
  for (const record of [...data.deposits, ...data.groceries]) {
    if (!ids.members.has(record.memberId) || !Number.isSafeInteger(record.amount) || record.amount <= 0 || !Number.isFinite(Date.parse(record.date))) throw new Error('Invalid financial record or missing member in source.');
  }
  for (const purchase of data.groceries) if (typeof purchase.note !== 'string' || !purchase.note.trim()) throw new Error('Invalid purchase note in source.');
  for (const meal of data.meals) {
    const slot = `${meal.date}/${meal.slot}`;
    if (dates.has(slot) || !/^\d{4}-\d{2}-\d{2}$/.test(meal.date) || !Number.isFinite(Date.parse(meal.date)) || new Date(meal.date).toISOString().slice(0, 10) !== meal.date || !slots.includes(meal.slot) || typeof meal.dish !== 'string' || !meal.dish.trim()) throw new Error('Invalid or duplicate meal in source.');
    dates.add(slot);
    if (meal.approximateCost !== null && (!Number.isSafeInteger(meal.approximateCost) || meal.approximateCost < 0)) throw new Error('Invalid approximate cost in source.');
    if (!Array.isArray(meal.attendees) || !meal.attendees.length) throw new Error('Meal without attendance in source.');
    const seen = new Set();
    for (const person of meal.attendees) {
      if (!ids.members.has(person.memberId) || seen.has(person.memberId) || !Number.isInteger(person.quantity) || person.quantity < 1 || !Number.isInteger(person.guests) || person.guests < 0 || person.guests > 20 || person.quantity + person.guests > 40) throw new Error('Invalid attendance or missing member in source.');
      seen.add(person.memberId);
    }
  }
  return data;
}

export function readSqliteSnapshot(source) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('BEGIN');
    const data = emptyData();
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((table) => table.name));
    if (!tables.has('members')) throw new Error('Source is not a Meal Manage database.');
    data.members = db.prepare('SELECT id, name, phone, joined, active FROM members ORDER BY id').all().map((record) => ({ ...record, active: Boolean(record.active) }));
    for (const name of ['deposits', 'groceries']) if (tables.has(name)) data[name] = db.prepare(`SELECT * FROM ${name} ORDER BY id`).all().map((record) => ({ ...record }));
    if (tables.has('meals')) {
      const mealColumns = db.prepare('PRAGMA table_info(meals)').all();
      const hasEstimate = mealColumns.some((column) => column.name === 'approximateCost');
      const hasQuantity = tables.has('attendees') && db.prepare('PRAGMA table_info(attendees)').all().some((column) => column.name === 'quantity');
      data.meals = db.prepare('SELECT * FROM meals ORDER BY id').all().map((record) => ({
        ...record,
        approximateCost: hasEstimate ? record.approximateCost : null,
        attendees: tables.has('attendees') ? db.prepare(`SELECT memberId, guests, ${hasQuantity ? 'quantity' : '1 AS quantity'} FROM attendees WHERE mealId = ? ORDER BY memberId`).all(record.id).map((person) => ({ ...person })) : [],
      }));
    }
    validateSnapshot(data);
    db.exec('COMMIT');
    return data;
  } finally { db.close(); }
}

export async function importSnapshot(store, source) {
  validateSnapshot(source);
  return store.update((draft) => {
    if (collections.some((name) => draft[name].length)) throw new Error('Atlas is not empty. Import cancelled; existing data was not changed.');
    for (const name of collections) draft[name] = structuredClone(source[name]);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let store;
  try {
    const sourceAt = process.argv.indexOf('--source');
    const source = sourceAt >= 0 ? process.argv[sourceAt + 1] : 'data/meal-manage.sqlite';
    if (!source || source.startsWith('--')) throw new Error('Provide a source SQLite path.');
    const data = readSqliteSnapshot(source);
    console.log('Source counts:', Object.fromEntries(collections.map((name) => [name, data[name].length])));
    if (process.argv.includes('--apply')) {
      store = await MongoStore.connect();
      await importSnapshot(store, data);
      console.log('Import committed to Atlas. The SQLite source was not modified.');
    } else console.log('Dry run only. Add --apply to import into an empty Atlas database.');
  } catch (error) {
    console.error(error.name?.startsWith('Mongo') ? 'Atlas connection or import failed; check credentials and network access.' : 'Import failed: ' + error.message);
    process.exitCode = 1;
  } finally { if (store) await store.close(); }
}
