// Black-box tests against a running server: BASE_URL=http://localhost:3000 API_KEY=... node test.js
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const KEY = process.env.API_KEY;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const iso = (ms) => new Date(Date.now() + ms).toISOString().replace('.000Z', 'Z');
const H = 3600e3;
(async () => {
  // auth
  let r = await fetch(BASE + '/slots'); ok(r.status === 401, 'no key -> 401');
  r = await fetch(BASE + '/slots', { headers: { 'X-API-Key': 'wrong' } }); ok(r.status === 401, 'bad key -> 401');
  r = await fetch(BASE + '/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"slots":[]}' }); ok(r.status === 401, 'reset needs key');

  const slots = [
    { id: 's2', provider: 'Dr Bello', start: iso(3 * H), end: iso(3.5 * H) },
    { id: 's1', provider: 'Dr Ade', start: iso(2 * H), end: iso(2.5 * H) },
    { id: 'past', provider: 'Dr Ade', start: iso(-2 * H), end: iso(-1.5 * H) },
    ...Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, provider: 'Dr Pat', start: iso((10 + i) * H), end: iso((10.5 + i) * H) })),
  ];
  r = await call('POST', '/reset', { slots }); ok(r.status === 200, 'reset 200');
  r = await call('GET', '/slots');
  ok(r.status === 200 && r.body.slots[0].id === 'past' && r.body.slots[1].id === 's1', 'slots sorted by start');
  ok(r.body.slots.every((s) => s.available === true), 'all available');
  ok(r.body.slots.find((s) => s.id === 's1').start === slots[1].start, 'start echoed as sent');
  r = await call('GET', '/slots?provider=Dr%20Ade'); ok(r.body.slots.length === 2, 'provider filter');

  // level 1/2
  r = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada Obi ', email: '  ADA@Example.com ' });
  ok(r.status === 201 && r.body.status === 'confirmed' && r.body.name === 'Ada Obi' && r.body.email === 'ada@example.com' && r.body.id && r.body.created_at, 'book ok + trimmed/lowercased');
  const b1 = r.body;
  r = await call('GET', '/bookings/' + b1.id); ok(r.status === 200 && r.body.id === b1.id, 'lookup');
  r = await call('GET', '/bookings/nope'); ok(r.status === 404 && r.body.error, 'lookup 404');
  r = await call('GET', '/slots'); ok(r.body.slots.find((s) => s.id === 's1').available === false, 'booked slot unavailable');
  for (const [body, label] of [[{ name: 'a', email: 'a@b.co' }, 'no slot'], [{ slot_id: 's2', email: 'a@b.co' }, 'no name'], [{ slot_id: 's2', name: '  ', email: 'a@b.co' }, 'blank name'], [{ slot_id: 's2', name: 'a' }, 'no email'], [{ slot_id: 's2', name: 'a', email: 'bad' }, 'bad email'], [{ slot_id: 's2', name: 5, email: 'a@b.co' }, 'non-string']]) {
    r = await call('POST', '/bookings', body); ok(r.status === 400 && r.body.error, '400 ' + label);
  }
  r = await call('POST', '/bookings', { slot_id: 'zzz', name: 'a', email: 'v1@b.co' }); ok(r.status === 404, 'unknown slot 404');
  r = await call('POST', '/bookings', { slot_id: 'past', name: 'a', email: 'v2@b.co' }); ok(r.status === 400, 'past slot 400');
  r = await fetch(BASE + '/bookings', { method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: '{oops' }); ok(r.status === 400, 'malformed json 400');

  // level 3
  r = await call('POST', '/bookings', { slot_id: 's1', name: 'Other', email: 'other@b.co' }); ok(r.status === 409, 'double book 409');
  const race = await Promise.all(Array.from({ length: 40 }, (_, i) => call('POST', '/bookings', { slot_id: 's2', name: 'R' + i, email: `race${i}@b.co` })));
  const wins = race.filter((x) => x.status === 201), losers = race.filter((x) => x.status === 409);
  ok(wins.length === 1 && losers.length === 39, `race: 1 winner, 39 conflicts (got ${wins.length}/${losers.length})`);
  r = await call('DELETE', '/bookings/' + wins[0].body.id); ok(r.status === 200 && r.body.status === 'cancelled', 'cancel');
  r = await call('DELETE', '/bookings/' + wins[0].body.id); ok(r.status === 409, 'cancel twice 409');
  r = await call('DELETE', '/bookings/nope'); ok(r.status === 404, 'cancel unknown 404');
  r = await call('GET', '/slots'); ok(r.body.slots.find((s) => s.id === 's2').available === true, 'cancel frees slot');
  r = await call('POST', '/bookings', { slot_id: 's2', name: 'Again', email: 'again@b.co' }); ok(r.status === 201, 'rebook after cancel');

  // level 4: idempotency
  r = await call('POST', '/reset', { slots });
  const body = { slot_id: 'p0', name: 'Idem', email: 'idem@b.co' };
  const par = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/bookings', body, { 'Idempotency-Key': 'k1' })));
  ok(par.every((x) => x.status === 201 && x.body.id === par[0].body.id), 'parallel same key -> same 201 + id');
  r = await call('POST', '/bookings', body, { 'Idempotency-Key': 'k1' }); ok(r.status === 201 && r.body.id === par[0].body.id, 'replay same');
  r = await call('POST', '/bookings', { ...body, slot_id: 'p1' }, { 'Idempotency-Key': 'k1' }); ok(r.status === 422, 'same key different body 422');
  r = await call('GET', '/bookings?email=IDEM@b.co'); ok(r.body.bookings.length === 1, 'only one booking created');
  // paging
  for (let i = 1; i <= 5; i++) await call('POST', '/bookings', { slot_id: 'p' + i, name: 'Pg', email: 'pg@b.co' });
  let seen = [], cur = null, pages = 0;
  do { r = await call('GET', '/bookings?email=pg@B.co&limit=2' + (cur ? '&cursor=' + encodeURIComponent(cur) : '')); seen.push(...r.body.bookings.map((x) => x.id)); cur = r.body.next_cursor; pages++; } while (cur && pages < 10);
  ok(seen.length === 5 && new Set(seen).size === 5 && pages === 3, `paging 5 in 3 pages (got ${seen.length}/${pages})`);
  r = await call('GET', '/bookings?email=pg@b.co&limit=5'); ok(r.body.next_cursor === null && r.body.bookings.length === 5, 'exact last page has null cursor');
  for (const l of ['0', '51', 'abc', '-1', '2.5']) { r = await call('GET', '/bookings?email=pg@b.co&limit=' + l); ok(r.status === 400, 'limit ' + l + ' -> 400'); }
  r = await call('GET', '/bookings?email=nobody@b.co'); ok(r.status === 200 && r.body.bookings.length === 0 && r.body.next_cursor === null, 'empty list');

  // level 5
  r = await call('POST', '/reset', { slots });
  const rl = [];
  for (let i = 0; i < 7; i++) rl.push(await call('POST', '/bookings', { slot_id: i < 2 ? 'p0' : 'zzz', name: 'Spam', email: 'spam@b.co' }));
  ok(rl.slice(0, 5).every((x) => x.status !== 429), 'first 5 not limited (failures count)');
  ok(rl[5].status === 429 && rl[6].status === 429, '6th and 7th are 429');
  const ra = Number(rl[5].headers.get('retry-after')); ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, 'Retry-After whole seconds, got ' + rl[5].headers.get('retry-after'));
  r = await call('POST', '/bookings', { slot_id: 'p5', name: 'Fine', email: 'fine@b.co' }); ok(r.status === 201, 'other email unaffected');
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/bookings', { slot_id: 'p' + (6 + (i % 6)), name: 'B', email: 'burst@b.co' })));
  ok(burst.filter((x) => x.status === 429).length === 15, 'parallel burst: exactly 15 of 20 limited, got ' + burst.filter((x) => x.status === 429).length);

  await call('POST', '/reset', { slots: [] });
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
