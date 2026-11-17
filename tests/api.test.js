import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, getListenOptions } from '../server.js';
import { MemoryStore } from './support/memory-store.js';
import { approximateMealRate, calculateBalances } from '../public/model.js';

async function start(t, state, options = {}) {
  const store = new MemoryStore(state);
  const server = await createApp({ store, username: 'admin', password: 'test-password', ...options });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.dispose(); } };
  t.after(close);
  let cookie = '';
  // Exercise the real HTTP request listener without binding a network socket.
  const request = async (route, body, method = 'POST', headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = body === undefined ? 'GET' : method;
    req.url = route;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = Object.fromEntries(Object.entries({ host: 'localhost', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
    const response = await new Promise((resolve) => {
      const responseHeaders = new Headers();
      let status = 200;
      const res = {
        setHeader(name, value) { responseHeaders.set(name, value); },
        writeHead(code, values) { status = code; for (const [name, value] of Object.entries(values)) responseHeaders.set(name, value); },
        end(content) { resolve(new Response(content, { status, headers: responseHeaders })); },
      };
      server.emit('request', req, res);
    });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { response, body: response.headers.get('content-type').startsWith('application/json') ? await response.json() : null };
  };
  const login = () => request('/api/login', { username: 'admin', password: 'test-password' });
  return { server, close, request, login, get cookie() { return cookie; } };
}

test('authentication protects records, rejects bad passwords, and logs out', async (t) => {
  const { request, login } = await start(t);
  assert.equal((await request('/api/data')).response.status, 401);
  assert.equal((await request('/api/session')).body.authenticated, false);
  assert.equal((await request('/api/login', { username: 'admin', password: 'wrong' })).response.status, 401);
  const result = await login();
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/session')).body.authenticated, true);
  assert.equal((await request('/api/data')).response.status, 200);
  await request('/api/logout', {});
  assert.equal((await request('/api/data')).response.status, 401);
});

test('production accepts a configured nine-character password without using default credentials', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const password = 'p'.repeat(9);
  const { request } = await start(t, undefined, { username: 'operator', password });
  assert.equal((await request('/api/login', { username: 'admin', password: 'admin12345' })).response.status, 401);
  const login = await request('/api/login', { username: 'operator', password });
  assert.equal(login.response.status, 200);
  assert.equal((await request('/api/data')).response.status, 200);
  for (const invalid of ['', ' '.repeat(8), 'p'.repeat(7), 'p'.repeat(257)]) {
    await assert.rejects(createApp({ store: new MemoryStore(), username: 'operator', password: invalid }), { name: 'ConfigurationError', message: /ADMIN_PASSWORD/ });
  }
  await assert.rejects(createApp({ store: new MemoryStore(), username: ' ', password }), { name: 'ConfigurationError', message: /ADMIN_USERNAME/ });
});

test('invalid production credentials explain the startup failure without printing the password', (t) => {
  const password = 'p'.repeat(7);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'production', PORT: '10000', ADMIN_USERNAME: 'operator', ADMIN_PASSWORD: password },
    encoding: 'utf8',
    timeout: 5000,
  });
  if (['EPERM', 'EACCES'].includes(result.error?.code)) return t.skip('This environment blocks subprocess execution.');
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Startup failed: ADMIN_PASSWORD must contain 8–256 characters/);
  assert(!result.stderr.includes(password));
  assert(!result.stderr.includes('MongoDB Atlas'));
});

test('member, deposit, purchase and guest attendance persist with validation', async (t) => {
  const { request, login } = await start(t);
  await login();
  let result = await request('/api/members', { name: 'Rahim', phone: '' });
  assert.equal(result.response.status, 201);
  const memberId = result.body.members[0].id;
  assert.equal((await request('/api/members', { name: '   ' })).response.status, 400);
  const date = '2026-11-17T12:00:00.000Z';
  for (const amount of ['0', '-5', '1.234', 'NaN', 100]) assert.equal((await request('/api/deposits', { memberId, amount, date })).response.status, 400);
  assert.equal((await request('/api/deposits', { memberId: 999, amount: '10', date })).response.status, 400);
  assert.equal((await request('/api/deposits', { memberId, amount: '10', date: 'invalid' })).response.status, 400);
  result = await request('/api/deposits', { memberId, amount: '3000.05', date });
  assert.equal(result.body.deposits[0].amount, 300005);
  result = await request('/api/groceries', { memberId, amount: '500', date, note: 'Rice' });
  assert.equal(result.body.groceries[0].amount, 50000);
  const meal = { date: '2026-11-17', slot: 'lunch', dish: 'Rice', attendees: [{ memberId, guests: 1 }] };
  assert.equal((await request('/api/meals', { ...meal, date: '2026-02-30' })).response.status, 400);
  assert.equal((await request('/api/meals', { ...meal, attendees: [] })).response.status, 400);
  assert.equal((await request('/api/meals', { ...meal, attendees: [{ memberId, guests: -1 }] })).response.status, 400);
  assert.equal((await request('/api/meals', { ...meal, attendees: [...meal.attendees, ...meal.attendees] })).response.status, 400);
  result = await request('/api/meals', meal);
  assert.equal(result.response.status, 201);
  assert.equal(result.body.meals[0].attendees[0].guests, 1);
  assert.equal((await request('/api/meals', meal)).response.status, 409);
  result = await request(`/api/members/${memberId}`, { name: 'Rahim Ahmed', active: false }, 'PUT');
  assert.equal(result.body.members[0].active, false);
  assert.equal(result.body.members[0].name, 'Rahim Ahmed');
  assert.equal(result.body.meals.length, 1);
  assert.equal((await request('/api/meals', { ...meal, slot: 'dinner' })).response.status, 400);
});

test('data survives application instances while sessions do not', async (t) => {
  const state = { data: { members: [], deposits: [], groceries: [], meals: [] }, counters: {} };
  const first = await start(t, state);
  await first.login();
  await first.request('/api/members', { name: 'Karim', phone: '' });
  const previousCookie = first.cookie;
  await first.close();
  const second = await start(t, state);
  assert.equal((await second.request('/api/session', undefined, 'GET', { cookie: previousCookie })).body.authenticated, false);
  await second.login();
  assert.equal((await second.request('/api/data')).body.members[0].name, 'Karim');
});

test('cross-origin writes, unknown endpoints and private files are rejected', async (t) => {
  const { request, login } = await start(t);
  await login();
  assert.equal((await request('/api/members', { name: 'Rahim' }, 'POST', { Origin: 'https://untrusted.example' })).response.status, 403);
  assert.equal((await request('/api/unknown')).response.status, 404);
  for (const file of ['/server.js', '/.env', '/data/meal-manage.sqlite']) assert.equal((await request(file)).response.status, 404);
  assert.equal((await request('/balances')).response.status, 200);
  for (const file of ['/assets/motion/motion.css', '/assets/motion/motion.js']) {
    assert.equal((await request(file)).response.status, 200);
  }
});

test('meal references and individual quantities are validated and saved', async (t) => {
  const { request, login } = await start(t);
  await login();
  const { body } = await request('/api/members', { name: 'Rahim', phone: '' });
  const memberId = body.members[0].id;
  const meal = { date: '2026-11-17', slot: 'lunch', dish: 'Rice', approximateCost: '65.50', attendees: [{ memberId, quantity: 2, guests: 1 }] };
  for (const approximateCost of ['-1', '1.234', 'NaN', '100000000', {}, 65.5]) {
    const invalid = await request('/api/meals', { ...meal, approximateCost });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.field, 'approximateCost');
  }
  for (const quantity of [0, -1, 41, 1.5, '2', null]) {
    assert.equal((await request('/api/meals', { ...meal, attendees: [{ memberId, quantity, guests: 1 }] })).response.status, 400);
  }
  const result = await request('/api/meals', meal);
  assert.equal(result.response.status, 201);
  assert.equal(result.body.meals[0].approximateCost, 6550);
  assert.deepEqual(result.body.meals[0].attendees, [{ memberId, quantity: 2, guests: 1 }]);
  assert.equal((await request('/api/data')).body.meals[0].approximateCost, 6550);
  const free = await request('/api/meals', { ...meal, slot: 'dinner', approximateCost: '0' });
  assert.equal(free.body.meals[0].approximateCost, 0);
  const omitted = await request('/api/meals', { ...meal, date: '2026-11-18', approximateCost: '', attendees: [{ memberId, guests: 0 }] });
  assert.equal(omitted.body.meals[0].approximateCost, null);
  assert.equal(omitted.body.meals[0].attendees[0].quantity, 1);
});

test('deposits and purchases can be edited and deleted with recalculated balances', async (t) => {
  const { request, login } = await start(t);
  await login();
  const rahim = (await request('/api/members', { name: 'Rahim' })).body.members[0].id;
  const karim = (await request('/api/members', { name: 'Karim' })).body.members.find((member) => member.name === 'Karim').id;
  const date = '2026-11-17T12:00:00.000Z';
  const deposit = (await request('/api/deposits', { memberId: rahim, amount: '3000', date })).body.deposits[0];
  const purchase = (await request('/api/groceries', { memberId: rahim, amount: '600', note: 'Rice', date })).body.groceries[0];
  await request('/api/meals', { date: '2026-11-17', slot: 'lunch', dish: 'Rice', attendees: [{ memberId: rahim, guests: 0 }, { memberId: karim, guests: 0 }] });
  let result = await request(`/api/deposits/${deposit.id}`, { memberId: karim, amount: '4000.25', date: '2026-11-18T13:00:00.000Z' }, 'PUT');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.deposits, [{ id: deposit.id, memberId: karim, amount: 400025, date: '2026-11-18T13:00:00.000Z' }]);
  result = await request(`/api/groceries/${purchase.id}`, { memberId: karim, amount: '1000', note: 'Rice and fish', date }, 'PUT');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.groceries, [{ id: purchase.id, memberId: karim, amount: 100000, note: 'Rice and fish', date }]);
  let balances = calculateBalances(result.body);
  assert.equal(balances.cash, 300025);
  assert.equal(balances.rate, 50000);
  assert.equal(balances.rows.find((member) => member.id === karim).balance, 350025);
  const beforeInvalid = result.body;
  assert.equal((await request(`/api/deposits/${deposit.id}`, { memberId: rahim, amount: '-5', date }, 'PUT')).response.status, 400);
  assert.equal((await request(`/api/groceries/${purchase.id}`, { memberId: rahim, amount: '10', note: '', date }, 'PUT')).response.status, 400);
  assert.deepEqual((await request('/api/data')).body, beforeInvalid);
  result = await request(`/api/groceries/${purchase.id}`, {}, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.groceries, []);
  balances = calculateBalances(result.body);
  assert.equal(balances.rate, 0);
  assert.equal(balances.cash, 400025);
  result = await request(`/api/deposits/${deposit.id}`, {}, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.deposits, []);
  assert.equal(calculateBalances(result.body).cash, 0);
});

test('meal edits replace attendance atomically and retain existing inactive participants', async (t) => {
  const { request, login } = await start(t);
  await login();
  const rahim = (await request('/api/members', { name: 'Rahim' })).body.members[0].id;
  const karim = (await request('/api/members', { name: 'Karim' })).body.members.find((member) => member.name === 'Karim').id;
  const meal = { date: '2026-11-17', slot: 'lunch', dish: 'Rice', approximateCost: '100', attendees: [{ memberId: rahim, guests: 1, quantity: 2 }] };
  const mealId = (await request('/api/meals', meal)).body.meals[0].id;
  await request('/api/meals', { ...meal, slot: 'dinner', attendees: [{ memberId: karim, guests: 0 }] });
  await request(`/api/members/${rahim}`, { active: false }, 'PUT');
  const edited = { ...meal, dish: 'Rice and fish', approximateCost: '350.50', attendees: [{ memberId: rahim, guests: 2, quantity: 3 }] };
  let result = await request(`/api/meals/${mealId}`, edited, 'PUT');
  assert.equal(result.response.status, 200);
  const updatedMeal = result.body.meals.find((entry) => entry.id === mealId);
  assert.equal(updatedMeal.dish, 'Rice and fish');
  assert.equal(updatedMeal.approximateCost, 35050);
  assert.deepEqual(updatedMeal.attendees, [{ memberId: rahim, guests: 2, quantity: 3 }]);
  assert.equal(calculateBalances(result.body).rows.find((member) => member.id === rahim).meals, 5);
  await request(`/api/members/${karim}`, { active: false }, 'PUT');
  const beforeInvalid = (await request('/api/data')).body;
  assert.equal((await request(`/api/meals/${mealId}`, { ...edited, attendees: [...edited.attendees, { memberId: karim, guests: 0 }] }, 'PUT')).response.status, 400);
  assert.equal((await request(`/api/meals/${mealId}`, { ...edited, slot: 'dinner' }, 'PUT')).response.status, 409);
  assert.equal((await request(`/api/meals/${mealId}`, { ...edited, attendees: [] }, 'PUT')).response.status, 400);
  assert.deepEqual((await request('/api/data')).body, beforeInvalid);
  result = await request(`/api/meals/${mealId}`, {}, 'DELETE');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.meals.length, 1);
  assert.equal(calculateBalances(result.body).rows.find((member) => member.id === rahim).meals, 0);
  // Removing the meal also removes its attendance references.
  assert.equal((await request(`/api/members/${rahim}`, {}, 'DELETE')).response.status, 200);
});

test('member deletion preserves linked deposits, purchases and meal history', async (t) => {
  const { request, login } = await start(t);
  await login();
  const memberId = (await request('/api/members', { name: 'Rahim', phone: 'test' })).body.members[0].id;
  const joined = (await request('/api/data')).body.members[0].joined;
  const updated = await request(`/api/members/${memberId}`, { name: 'Rahim Ahmed', phone: '' }, 'PUT');
  assert.equal(updated.body.members[0].joined, joined);
  assert.equal(updated.body.members[0].name, 'Rahim Ahmed');
  for (const type of ['deposits', 'groceries', 'meals']) {
    const payload = type === 'meals' ? { date: '2026-11-17', slot: 'lunch', dish: 'Rice', attendees: [{ memberId, guests: 0 }] }
      : { memberId, amount: '10', date: '2026-11-17T12:00:00.000Z', ...(type === 'groceries' ? { note: 'Rice' } : {}) };
    const record = (await request(`/api/${type}`, payload)).body[type][0];
    const before = (await request('/api/data')).body;
    const rejected = await request(`/api/members/${memberId}`, {}, 'DELETE');
    assert.equal(rejected.response.status, 409);
    assert.match(rejected.body.error, /Deactivate/);
    assert.deepEqual((await request('/api/data')).body, before);
    await request(`/api/${type}/${record.id}`, {}, 'DELETE');
  }
  const deleted = await request(`/api/members/${memberId}`, {}, 'DELETE');
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.body.members, []);
});

test('edit and delete endpoints require authentication, same origin and an existing record', async (t) => {
  const { request, login } = await start(t);
  for (const type of ['members', 'deposits', 'groceries', 'meals']) {
    for (const method of ['PUT', 'DELETE']) assert.equal((await request(`/api/${type}/1`, {}, method)).response.status, 401);
  }
  await login();
  const memberId = (await request('/api/members', { name: 'Karim' })).body.members[0].id;
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request(`/api/members/${memberId}`, { name: 'Changed' }, method, { Origin: 'https://untrusted.example' })).response.status, 403);
    for (const type of ['members', 'deposits', 'groceries', 'meals']) {
      assert.equal((await request(`/api/${type}/999`, {}, method)).response.status, 404);
      assert.equal((await request(`/api/${type}/99999999999999999999999`, {}, method)).response.status, 404);
    }
  }
  assert.equal((await request('/api/data')).body.members[0].name, 'Karim');
});

test('single portion totals accept the legacy maximum and reject invalid combined bounds', async (t) => {
  const { request, login } = await start(t);
  await login();
  const memberId = (await request('/api/members', { name: 'Rahim' })).body.members[0].id;
  const meal = { date: '2026-11-17', slot: 'lunch', dish: 'Rice', approximateCost: '400', attendees: [{ memberId, quantity: 40, guests: 0 }] };
  const created = await request('/api/meals', meal);
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.meals[0].attendees, [{ memberId, quantity: 40, guests: 0 }]);
  const before = created.body;
  const invalidAttendees = [
    { memberId, quantity: 0, guests: 0 },
    { memberId, quantity: 41, guests: 0 },
    { memberId, quantity: 40, guests: 1 },
    { memberId, quantity: 21, guests: 20 },
    { memberId, quantity: 1.5, guests: 0 },
    { memberId, quantity: '40', guests: 0 },
    { memberId, quantity: null, guests: 0 },
  ];
  for (const person of invalidAttendees) {
    const result = await request(`/api/meals/${created.body.meals[0].id}`, { ...meal, attendees: [person] }, 'PUT');
    assert.equal(result.response.status, 400);
    assert.equal(result.body.field, 'attendees');
  }
  assert.deepEqual((await request('/api/data')).body, before);
  const legacy = await request('/api/meals', { ...meal, slot: 'dinner', attendees: [{ memberId, quantity: 20, guests: 20 }] });
  assert.equal(legacy.response.status, 201);
  assert.equal(calculateBalances(legacy.body).totalMeals, 80);
});

test('health endpoint reports database readiness without exposing data', async (t) => {
  const { request } = await start(t);
  const health = await request('/healthz');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
});

test('Render binds its assigned port on all interfaces even with local HOST settings', () => {
  assert.deepEqual(getListenOptions({ RENDER: 'true', HOST: '127.0.0.1', PORT: '12345' }), { host: '0.0.0.0', port: 12345 });
  assert.deepEqual(getListenOptions({ NODE_ENV: 'production', HOST: 'localhost' }), { host: '0.0.0.0', port: 10000 });
  assert.deepEqual(getListenOptions({}), { host: '127.0.0.1', port: 3000 });
  for (const port of ['0', '-1', '65536', '3000.5', 'invalid']) assert.throws(() => getListenOptions({ PORT: port }), /PORT/);
});

test('HTTP starts during Atlas initialization, reports unavailable, then serves persisted records', { timeout: 2000 }, async (t) => {
  const connecting = Promise.withResolvers();
  const store = new MemoryStore({ data: { members: [{ id: 1, name: 'Rahim', active: true }], deposits: [], groceries: [], meals: [] }, counters: {} });
  t.after(() => connecting.resolve(store));
  const { server, request, login } = await start(t, undefined, { store: undefined, connectStore: () => connecting.promise });
  assert.equal((await request('/login')).response.status, 200);
  const health = await request('/healthz');
  assert.equal(health.response.status, 503);
  assert.equal(health.response.headers.get('retry-after'), '5');
  await login();
  assert.equal((await request('/api/data')).response.status, 503);
  assert.equal((await request('/api/members', { name: 'Karim' })).response.status, 503);
  connecting.resolve(store);
  await server.ready;
  assert.equal((await request('/healthz')).response.status, 200);
  assert.equal((await request('/api/data')).body.members[0].name, 'Rahim');
});

test('failed Atlas startup leaves HTTP responsive without exposing credentials or accepting writes', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const { server, request, login, close } = await start(t, undefined, {
    store: undefined,
    connectStore: async () => { throw Object.assign(new Error('mongodb+srv://private-credentials@cluster/'), { name: 'MongoServerSelectionError' }); },
  });
  await assert.rejects(server.ready, { name: 'MongoServerSelectionError' });
  assert.equal((await request('/healthz')).response.status, 503);
  await login();
  assert.equal((await request('/api/members', { name: 'Karim' })).response.status, 503);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Database initialization failed/);
  assert(!logged[0].includes('private-credentials'));
  await close();
});

test('health endpoint reports an outage after startup and recovers with the database', async (t) => {
  const store = new MemoryStore();
  const { request } = await start(t, undefined, { store });
  const health = t.mock.method(store, 'health', async () => { throw new Error('offline'); });
  assert.equal((await request('/healthz')).response.status, 503);
  health.mock.restore();
  assert.equal((await request('/healthz')).response.status, 200);
});

test('deleted record IDs are not reused and concurrent member changes remain distinct', async (t) => {
  const { request, login } = await start(t);
  await login();
  const first = await request('/api/members', { name: 'Rahim' });
  const id = first.body.members[0].id;
  await request(`/api/members/${id}`, {}, 'DELETE');
  await Promise.all([request('/api/members', { name: 'Rahim' }), request('/api/members', { name: 'Karim' })]);
  const members = (await request('/api/data')).body.members;
  assert.equal(members.length, 2);
  assert.equal(new Set(members.map((member) => member.id)).size, 2);
  assert(members.every((member) => member.id > id));
});

