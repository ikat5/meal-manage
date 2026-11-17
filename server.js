import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoStore } from './storage/mongo-store.js';
import { slots } from './public/model.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const sessionAge = 12 * 60 * 60 * 1000;
class HttpError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; }
}
const fail = (message, field) => { throw new HttpError(400, message, field); };
const textField = (value, field, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`Enter ${field} (up to ${max} characters).`, field);
  return value.trim();
};
const amountField = (value) => {
  if (typeof value !== 'string' || !/^\d{1,8}(\.\d{1,2})?$/.test(value) || Number(value) <= 0) fail('Enter an amount greater than 0 with up to two decimal places.', 'amount');
  return Math.round(Number(value) * 100);
};
const dateField = (value, dayOnly = false) => {
  if (typeof value !== 'string' || (dayOnly && !/^\d{4}-\d{2}-\d{2}$/.test(value)) || !Number.isFinite(Date.parse(value))) fail('Enter a valid date.', 'date');
  if (dayOnly && new Date(value).toISOString().slice(0, 10) !== value) fail('Enter a valid date.', 'date');
  return dayOnly ? value : new Date(value).toISOString();
};

const publicData = (data) => ({
  members: [...data.members].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
  deposits: [...data.deposits].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
  groceries: [...data.groceries].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
  meals: [...data.meals].sort((a, b) => b.date.localeCompare(a.date) || slots.indexOf(b.slot) - slots.indexOf(a.slot) || b.id - a.id),
});

function changeRecord(data, allocateId, type, id, method, body) {
  const current = id === null ? null : data[type].find((record) => record.id === id);
  if (id !== null && !current) throw new HttpError(404, 'This record no longer exists.');
  const memberField = (value, field = 'memberId', activeOnly = false) => {
    if (!Number.isSafeInteger(value)) fail('Choose a member.', field);
    const member = data.members.find((record) => record.id === value);
    if (!member || (activeOnly && !member.active)) fail('Choose an active member.', field);
    return value;
  };
  if (method === 'DELETE') {
    if (type === 'members' && (data.deposits.some((record) => record.memberId === id) || data.groceries.some((record) => record.memberId === id) || data.meals.some((meal) => meal.attendees.some((person) => person.memberId === id)))) {
      throw new HttpError(409, 'This member has history. Deactivate them from Members instead.');
    }
    data[type] = data[type].filter((record) => record.id !== id);
    return;
  }
  let values;
  if (type === 'members') {
    const name = current && body.name === undefined ? current.name : textField(body.name, 'name', 80);
    const phone = current && body.phone === undefined ? current.phone : typeof body.phone === 'string' ? body.phone.trim() : '';
    if (phone.length > 40) fail('Enter a phone number of up to 40 characters.', 'phone');
    if (body.active !== undefined && typeof body.active !== 'boolean') fail('Choose an active state.', 'active');
    values = { name, phone, active: current ? body.active ?? current.active : true, joined: current?.joined || new Date().toISOString() };
  } else if (type === 'deposits' || type === 'groceries') {
    values = { memberId: memberField(body.memberId), amount: amountField(body.amount), date: dateField(body.date) };
    if (type === 'groceries') values.note = textField(body.note, 'note', 500);
  } else {
    const date = dateField(body.date, true);
    if (!slots.includes(body.slot)) fail('Choose breakfast, lunch, or dinner.', 'slot');
    const dish = textField(body.dish, 'dish', 200);
    let approximateCost = null;
    if (body.approximateCost !== undefined && body.approximateCost !== null && body.approximateCost !== '') {
      if (typeof body.approximateCost !== 'string' || !/^\d{1,8}(\.\d{1,2})?$/.test(body.approximateCost)) fail('Enter an approximate cost of 0 or more with up to two decimal places.', 'approximateCost');
      approximateCost = Math.round(Number(body.approximateCost) * 100);
    }
    if (!Array.isArray(body.attendees) || !body.attendees.length || body.attendees.length > 500) fail('Select at least one member.', 'attendees');
    const previousMembers = new Set((current?.attendees || []).map((person) => person.memberId));
    const seen = new Set();
    const attendees = body.attendees.map((person) => {
      if (!person || typeof person !== 'object') fail('Choose an active member.', 'attendees');
      memberField(person.memberId, 'attendees', !previousMembers.has(person.memberId));
      if (seen.has(person.memberId)) fail('Select each member once.', 'attendees');
      seen.add(person.memberId);
      const guests = person.guests === undefined ? 0 : person.guests;
      const quantity = person.quantity === undefined ? 1 : person.quantity;
      if (!Number.isInteger(guests) || guests < 0 || guests > 20) fail('Use 0–20 guests per member.', 'attendees');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 40) fail('Use 1–40 portions per member.', 'attendees');
      if (quantity + guests > 40) fail('Use at most 40 total portions per member.', 'attendees');
      return { memberId: person.memberId, guests, quantity };
    }).sort((a, b) => a.memberId - b.memberId);
    if (data.meals.some((meal) => meal.date === date && meal.slot === body.slot && meal.id !== id)) throw new HttpError(409, 'This meal slot has already been logged.', 'slot');
    values = { date, slot: body.slot, dish, approximateCost, attendees };
  }
  if (current) Object.assign(current, values);
  else data[type].push({ id: allocateId(type), ...values });
}

export async function createApp(options = {}) {
  const production = process.env.NODE_ENV === 'production';
  const username = options.username ?? process.env.ADMIN_USERNAME ?? 'admin';
  const password = options.password ?? process.env.ADMIN_PASSWORD ?? (production ? '' : 'admin12345');
  if (!username || !password || password.length > 256 || (production && password.length < 12)) throw new Error('Set an admin username and password; production requires at least 12 password characters.');
  const store = options.store ?? await MongoStore.connect(options.mongo);
  const secureCookie = process.env.SECURE_COOKIE === 'true' || (production && process.env.SECURE_COOKIE !== 'false');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  const sessions = new Map();
  const attempts = new Map();
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const bodyOf = async (req) => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send JSON data.');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 32768) throw new HttpError(413, 'This request is too large.');
    }
    try {
      const result = JSON.parse(body);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch { throw new HttpError(400, 'Send valid JSON data.'); }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route === '/healthz' && req.method === 'GET') {
        try { await store.health(); return json(res, 200, { status: 'ok' }); }
        catch { return json(res, 503, { status: 'unavailable' }); }
      }
      const token = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('session='))?.slice(8);
      const authenticated = token && (sessions.get(token) ?? 0) > Date.now();
      for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
      if (route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
          let allowed = false;
          try { allowed = new URL(req.headers.origin).host === req.headers.host; } catch {}
          if (!allowed) throw new HttpError(403, 'Request origin is not allowed.');
        }
        if (route === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: Boolean(authenticated), username: authenticated ? username : null, messName: process.env.MESS_NAME || 'MessName' });
        if (route === '/api/login' && req.method === 'POST') {
          const body = await bodyOf(req);
          const key = req.socket.remoteAddress;
          const now = Date.now();
          for (const [address, entry] of attempts) if (entry.until < now) attempts.delete(address);
          const attempt = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
          if (attempt.count >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
          const candidate = typeof body.password === 'string' && body.password.length <= 256 ? body.password : '';
          if (!timingSafeEqual(scryptSync(candidate, salt, 64), hash) || body.username !== username) {
            attempt.count++;
            attempts.set(key, attempt);
            throw new HttpError(401, 'Username or password is incorrect.', 'password');
          }
          attempts.delete(key);
          if (token) sessions.delete(token);
          const session = randomBytes(32).toString('hex');
          sessions.set(session, now + sessionAge);
          res.setHeader('Set-Cookie', `session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge / 1000}${secureCookie ? '; Secure' : ''}`);
          return json(res, 200, { username });
        }
        if (!authenticated) throw new HttpError(401, 'Log in to continue.');
        if (route === '/api/logout' && req.method === 'POST') {
          sessions.delete(token);
          res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/data' && req.method === 'GET') return json(res, 200, publicData(await store.read()));
        const collectionRoute = /^\/api\/(members|deposits|groceries|meals)$/.exec(route);
        const recordRoute = /^\/api\/(members|deposits|groceries|meals)\/(\d+)$/.exec(route);
        const create = collectionRoute && req.method === 'POST';
        const edit = recordRoute && ['PUT', 'DELETE'].includes(req.method);
        if (create || edit) {
          const type = (collectionRoute || recordRoute)[1];
          const id = recordRoute ? Number(recordRoute[2]) : null;
          if (id !== null && !Number.isSafeInteger(id)) throw new HttpError(404, 'This record no longer exists.');
          const body = req.method === 'DELETE' ? {} : await bodyOf(req);
          const data = await store.update((draft, allocateId) => changeRecord(draft, allocateId, type, id, req.method, body));
          return json(res, create ? 201 : 200, publicData(data));
        }
        throw new HttpError(404, 'This request could not be found.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      const pages = ['/', '/login', '/balances', '/members', '/deposits', '/meals', '/groceries'];
      const file = pages.includes(route) ? 'index.html' : route.slice(1);
      const allowed = new Set(['index.html', 'app.js', 'model.js', 'styles.css', 'favicon.svg', 'assets/motion/motion.css', 'assets/motion/motion.js']);
      if (!allowed.has(file)) throw new HttpError(404, 'Page not found.');
      const content = await readFile(path.join(root, 'public', file));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.name || 'Error');
      const status = error.status || (error.name?.startsWith('Mongo') ? 503 : 500);
      json(res, status, { error: error.status ? error.message : status === 503 ? 'Database unavailable. Try again.' : 'Something went wrong. Try again.', field: error.field });
    }
  });
  let disposed;
  server.dispose = () => disposed ||= Promise.resolve().then(() => store.close());
  server.once('close', () => { void server.dispose().catch(() => console.error('Database shutdown failed.')); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const production = process.env.NODE_ENV === 'production';
    const port = Number(process.env.PORT || (production ? 10000 : 3000));
    const host = process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
    const server = await createApp();
    server.listen(port, host, () => console.log(`Meal Manage is running on ${host}:${port}`));
    const shutdown = () => {
      server.close(() => { void server.dispose().then(() => process.exit(0)); });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    console.error('Startup failed. Check MongoDB Atlas access, MONGODB_URI, MONGODB_DB, and admin credentials. Error type:', error.name || 'Error');
    process.exitCode = 1;
  }
}
