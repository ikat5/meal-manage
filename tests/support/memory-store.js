import { emptyData } from '../../storage/mongo-store.js';

// Test double only. Production always uses MongoDB Atlas.
export class MemoryStore {
  constructor(state = { data: emptyData(), counters: {} }) {
    this.state = state;
    this.pending = Promise.resolve();
  }
  async read() { await this.pending; return structuredClone(this.state.data); }
  async update(change) {
    const action = this.pending.then(async () => {
      const draft = structuredClone(this.state.data);
      const counters = { ...this.state.counters };
      const allocateId = (name) => {
        counters[name] = Math.max(counters[name] || 0, draft[name].reduce((max, record) => Math.max(max, record.id), 0)) + 1;
        return counters[name];
      };
      await change(draft, allocateId);
      for (const name of Object.keys(draft)) counters[name] = Math.max(counters[name] || 0, ...draft[name].map((record) => record.id));
      this.state.data = draft;
      this.state.counters = counters;
      return structuredClone(draft);
    });
    this.pending = action.catch(() => {});
    return action;
  }
  async health() {}
  async close() { await this.pending; }
}
