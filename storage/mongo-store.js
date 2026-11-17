import { MongoClient } from 'mongodb';

export const collections = ['members', 'deposits', 'groceries', 'meals'];
export const emptyData = () => Object.fromEntries(collections.map((name) => [name, []]));
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10000 };

export class MongoStore {
  constructor(client, databaseName) {
    this.client = client;
    this.db = client.db(databaseName);
  }

  static async connect({ uri = process.env.MONGODB_URI, databaseName = process.env.MONGODB_DB || 'meal_manage' } = {}) {
    if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('Set a valid MONGODB_URI before starting the app.');
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) throw new Error('MONGODB_DB must contain only letters, digits, underscores, or hyphens.');
    const client = new MongoClient(uri, { appName: 'MealManage', maxPoolSize: 5, maxIdleTimeMS: 60000, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
    try {
      await client.connect();
      const store = new MongoStore(client, databaseName);
      await store.initialize();
      return store;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async initialize() {
    await this.db.command({ ping: 1 });
    for (const name of collections) await this.db.collection(name).createIndex({ id: 1 }, { unique: true });
    await this.db.collection('meals').createIndex({ date: 1, slot: 1 }, { unique: true });
    await this.db.collection('_meta').updateOne({ _id: 'state' }, { $setOnInsert: { revision: 0, counters: {} } }, { upsert: true });
  }

  async load(session) {
    const data = emptyData();
    // The MongoDB driver does not support parallel operations in a transaction.
    for (const name of collections) data[name] = await this.db.collection(name).find({}, { session, projection: { _id: 0 } }).toArray();
    return data;
  }

  async read() {
    return this.client.withSession((session) => session.withTransaction(() => this.load(session), transactionOptions));
  }

  async update(change) {
    return this.client.withSession((session) => session.withTransaction(async () => {
      // Serialize this mess's writes to prevent reference-check/delete races.
      // A conflicting writer is retried by withTransaction against a fresh snapshot.
      const metadata = await this.db.collection('_meta').findOneAndUpdate({ _id: 'state' }, { $inc: { revision: 1 } }, { session, returnDocument: 'after' });
      if (!metadata) throw new Error('Database metadata is missing. Restart the application.');
      const previous = await this.load(session);
      const draft = structuredClone(previous);
      const counters = { ...metadata.counters };
      const allocateId = (name) => {
        if (!collections.includes(name)) throw new Error('Unknown collection.');
        counters[name] = Math.max(counters[name] || 0, draft[name].reduce((max, record) => Math.max(max, record.id), 0)) + 1;
        if (!Number.isSafeInteger(counters[name])) throw new Error('Record ID limit reached.');
        return counters[name];
      };
      await change(draft, allocateId);
      for (const name of collections) {
        const before = new Map(previous[name].map((record) => [record.id, record]));
        const after = new Map(draft[name].map((record) => [record.id, record]));
        const operations = [];
        for (const record of draft[name]) {
          if (JSON.stringify(before.get(record.id)) !== JSON.stringify(record)) {
            operations.push({ replaceOne: { filter: { _id: record.id }, replacement: { _id: record.id, ...record }, upsert: !before.has(record.id) } });
          }
        }
        for (const record of previous[name]) if (!after.has(record.id)) operations.push({ deleteOne: { filter: { _id: record.id } } });
        if (operations.length) await this.db.collection(name).bulkWrite(operations, { session, ordered: true });
        counters[name] = Math.max(counters[name] || 0, draft[name].reduce((max, record) => Math.max(max, record.id), 0));
      }
      await this.db.collection('_meta').updateOne({ _id: 'state' }, { $set: { counters } }, { session });
      return draft;
    }, transactionOptions));
  }

  async health() { await this.db.command({ ping: 1 }, { timeoutMS: 5000 }); }
  async close() { await this.client.close(); }
}
