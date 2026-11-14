// Clinic booking API (Koya assessment, Task 1). Express + Postgres.
// Correctness under concurrency is enforced by the database, not by JS memory:
//  - Level 3: partial unique index on bookings(slot_id) WHERE status='confirmed'
//  - Level 4: idempotency table guarded by a per-key advisory lock
//  - Level 5: attempts table counted inside a per-email advisory lock
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const API_KEY = process.env.API_KEY;
if (!API_KEY) { console.error('API_KEY env var is required'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 20,
});

const RATE_LIMIT = 5;           // attempts per email
const RATE_WINDOW_MS = 60_000;  // per minute

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  start_raw TEXT NOT NULL,
  end_raw TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot ON bookings(slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings(email, seq);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  status INT NOT NULL,
  response JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts(email, at);
`;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Web page (public, no key needed to load it) ---------------------------
// The demo page gets the key injected so it works out of the box for reviewers.
const fs = require('fs');
const pageHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(pageHtml.replace('__API_KEY__', JSON.stringify(API_KEY)));
});
app.get('/health', (req, res) => res.json({ ok: true }));

// --- Level 2: API key on every API request ---------------------------------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  const key = req.get('X-API-Key');
  if (!key || !safeEqual(key, API_KEY)) return res.status(401).json({ error: 'missing or invalid API key' });
  next();
});

app.use(express.json({ limit: '1mb' }));

const err = (res, status, message) => res.status(status).json({ error: message });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

const isStr = (v) => typeof v === 'string';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isIso = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

const slotOut = (r) => ({ id: r.id, provider: r.provider, start: r.start_raw, end: r.end_raw, available: !r.booked });
const bookingOut = (r) => ({
  id: r.id, slot_id: r.slot_id, name: r.name, email: r.email, status: r.status,
  created_at: new Date(r.created_at).toISOString(),
});

// --- Level 1: reset + slots -------------------------------------------------
app.post('/reset', wrap(async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return err(res, 400, 'slots must be an array');
  const ids = new Set();
  for (const s of slots) {
    if (!s || !isStr(s.id) || !s.id || !isStr(s.provider) || !isIso(s.start) || !isIso(s.end) || ids.has(s.id)) {
      return err(res, 400, 'each slot needs a unique id, provider, start and end');
    }
    ids.add(s.id);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE bookings, idempotency, attempts, slots RESTART IDENTITY CASCADE');
    for (const s of slots) {
      await c.query('INSERT INTO slots(id, provider, start_raw, end_raw, start_at) VALUES ($1,$2,$3,$4,$5)',
        [s.id, s.provider, s.start, s.end, new Date(s.start)]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  res.json({ ok: true, slots: slots.length });
}));

app.get('/slots', wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.provider !== undefined) { params.push(String(req.query.provider)); where = 'WHERE s.provider = $1'; }
  const { rows } = await pool.query(
    `SELECT s.*, EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS booked
       FROM slots s ${where} ORDER BY s.start_at ASC, s.id ASC`, params);
  res.json({ slots: rows.map(slotOut) });
}));

// --- Booking ----------------------------------------------------------------
app.post('/bookings', wrap(async (req, res) => {
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // Level 2: validation. Trim name/email, lower-case email.
  const slotId = isStr(b.slot_id) ? b.slot_id.trim() : '';
  const name = isStr(b.name) ? b.name.trim() : '';
  const email = isStr(b.email) ? b.email.trim().toLowerCase() : '';
  if (!slotId) return err(res, 400, 'slot_id is required');
  if (!name) return err(res, 400, 'name is required');
  if (!email) return err(res, 400, 'email is required');
  if (!EMAIL_RE.test(email)) return err(res, 400, 'email is not valid');

  const idemKey = req.get('Idempotency-Key');
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify([slotId, name, email])).digest('hex');

  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // Level 4: serialise requests that share a key, then replay or reject.
    if (idemKey) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['idem:' + idemKey]);
      const { rows } = await c.query('SELECT * FROM idempotency WHERE key = $1', [idemKey]);
      if (rows.length) {
        await c.query('COMMIT');
        if (rows[0].body_hash !== bodyHash) return err(res, 422, 'Idempotency-Key was already used with a different request body');
        return res.status(rows[0].status).json(rows[0].response);
      }
    }

    // Level 5: 5 attempts per email per minute, failures included.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rate:' + email]);
    await c.query(`DELETE FROM attempts WHERE at < clock_timestamp() - interval '1 hour'`);
    const rl = await c.query(
      `SELECT count(*)::int AS n, min(at) AS oldest FROM attempts
        WHERE email = $1 AND at > clock_timestamp() - ($2 || ' milliseconds')::interval`,
      [email, String(RATE_WINDOW_MS)]);
    if (rl.rows[0].n >= RATE_LIMIT) {
      await c.query('COMMIT');
      const waitMs = RATE_WINDOW_MS - (Date.now() - new Date(rl.rows[0].oldest).getTime());
      res.set('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
      return err(res, 429, 'too many booking attempts for this email, try again later');
    }
    await c.query('INSERT INTO attempts(email) VALUES ($1)', [email]);

    // Level 2: slot must exist and not have started.
    const slot = await c.query('SELECT * FROM slots WHERE id = $1', [slotId]);
    if (!slot.rows.length) { await c.query('COMMIT'); return err(res, 404, 'slot not found'); }
    if (new Date(slot.rows[0].start_at).getTime() <= Date.now()) { await c.query('COMMIT'); return err(res, 400, 'slot has already started'); }

    // Level 3: the unique partial index is the real guard against double booking.
    let booking;
    await c.query('SAVEPOINT ins');
    try {
      const id = 'b_' + crypto.randomUUID();
      const ins = await c.query(
        `INSERT INTO bookings(id, slot_id, name, email, status) VALUES ($1,$2,$3,$4,'confirmed') RETURNING *`,
        [id, slotId, name, email]);
      booking = bookingOut(ins.rows[0]);
    } catch (e) {
      if (e.code === '23505') { await c.query('ROLLBACK TO SAVEPOINT ins'); await c.query('COMMIT'); return err(res, 409, 'slot is already booked'); }
      throw e;
    }
    if (idemKey) {
      await c.query('INSERT INTO idempotency(key, body_hash, status, response) VALUES ($1,$2,201,$3)',
        [idemKey, bodyHash, JSON.stringify(booking)]);
    }
    await c.query('COMMIT');
    res.status(201).json(booking);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}));

// --- Level 4: a person's bookings, cursor pagination ------------------------
app.get('/bookings', wrap(async (req, res) => {
  const email = isStr(req.query.email) ? req.query.email.trim().toLowerCase() : '';
  if (!email) return err(res, 400, 'email is required');
  let limit = 10;
  if (req.query.limit !== undefined) {
    if (!/^\d+$/.test(String(req.query.limit))) return err(res, 400, 'limit must be an integer from 1 to 50');
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) return err(res, 400, 'limit must be an integer from 1 to 50');
  }
  let after = 0;
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    const m = /^c(\d+)$/.exec(Buffer.from(String(req.query.cursor), 'base64url').toString());
    if (!m) return err(res, 400, 'invalid cursor');
    after = m[1];
  }
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3', [email, after, limit + 1]);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from('c' + page[page.length - 1].seq).toString('base64url') : null;
  res.json({ bookings: page.map(bookingOut), next_cursor: next });
}));

app.get('/bookings/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) return err(res, 404, 'booking not found');
  res.json(bookingOut(rows[0]));
}));

// --- Level 3: cancel --------------------------------------------------------
app.delete('/bookings/:id', wrap(async (req, res) => {
  const upd = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`, [req.params.id]);
  if (upd.rows.length) return res.json(bookingOut(upd.rows[0]));
  const ex = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!ex.rows.length) return err(res, 404, 'booking not found');
  err(res, 409, 'booking is already cancelled');
}));

// --- Errors -----------------------------------------------------------------
app.use((req, res) => err(res, 404, 'not found'));
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed' || e.status === 400) return err(res, 400, 'invalid JSON body');
  console.error(e);
  err(res, 500, 'internal error');
});

async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM slots');
  if (rows[0].n > 0) return;
  const providers = ['Dr Ade', 'Dr Bello'];
  const base = new Date(); base.setUTCHours(0, 0, 0, 0);
  let n = 1;
  for (let d = 1; d <= 5; d++) for (const p of providers) for (const h of [9, 10, 11]) {
    const s = new Date(base.getTime() + d * 86400000 + h * 3600000);
    const e = new Date(s.getTime() + 30 * 60000);
    const iso = (x) => x.toISOString().replace('.000Z', 'Z');
    await pool.query('INSERT INTO slots(id, provider, start_raw, end_raw, start_at) VALUES ($1,$2,$3,$4,$5)',
      ['s' + n++, p, iso(s), iso(e), s]);
  }
}

async function main() {
  // The database can still be starting when the service boots on a fresh deploy, so retry for a while.
  for (let attempt = 1; ; attempt++) {
    try { await pool.query(SCHEMA); break; }
    catch (e) {
      if (attempt >= 30) throw e;
      console.log(`database not ready (${e.code || e.message}), retrying in 5s (${attempt}/30)`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await seedIfEmpty();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('listening on', port));
}
main().catch((e) => { console.error(e); process.exit(1); });
