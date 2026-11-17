import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoStore } from '../storage/mongo-store.js';

test('MongoDB commits, rolls back, serializes IDs and persists across clients', { skip: !process.env.MONGODB_TEST_URI }, async (t) => {
  const databaseName = `meal_manage_test_${randomUUID().replaceAll('-', '')}`;
  const options = { uri: process.env.MONGODB_TEST_URI, databaseName };
  const store = await MongoStore.connect(options);
  t.after(async () => { await store.db.dropDatabase(); await store.close(); });
  await Promise.all(Array.from({ length: 4 }, (_, index) => store.update((data, allocateId) => {
    data.members.push({ id: allocateId('members'), name: `Member ${index}`, phone: '', joined: '2026-11-17', active: true });
  })));
  const records = await store.read();
  assert.deepEqual(records.members.map((record) => record.id).sort(), [1, 2, 3, 4]);
  await assert.rejects(store.update((data) => { data.members = []; throw new Error('Abort mutation'); }), /Abort mutation/);
  assert.deepEqual(await store.read(), records);
  const second = await MongoStore.connect(options);
  try { assert.deepEqual(await second.read(), records); }
  finally { await second.close(); }
});
