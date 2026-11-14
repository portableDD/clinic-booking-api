# Clinic booking API

Express + Postgres implementation of the Koya assessment spec (levels 1-5), plus a small web page served at `/`.

## Run
```
npm install
DATABASE_URL=postgres://user@host/db API_KEY=your-key npm start
API_KEY=your-key BASE_URL=http://localhost:3000 npm test   # black-box tests
```
Env: `DATABASE_URL`, `API_KEY` (both required), `PORT`, `DATABASE_SSL=true` for hosted Postgres.

## How each level is enforced
- **1** `/reset`, `/slots`, `/bookings`, `/bookings/:id`. Slot times are echoed exactly as sent.
- **2** `X-API-Key` checked on every API route (constant-time compare). Validation order: 400 fields, 404 slot, 400 started. Name/email trimmed, email lower-cased.
- **3** A partial unique index `ON bookings(slot_id) WHERE status='confirmed'` makes double booking impossible; a violation maps to 409. Cancelling sets `cancelled`, which frees the slot.
- **4** `Idempotency-Key`: a per-key Postgres advisory lock serialises retries, so the same key and body replay the stored 201 (same id); a different body gives 422. Paging uses an opaque cursor over an increasing sequence number, oldest first.
- **5** Attempts are recorded in Postgres and counted under a per-email advisory lock, so the limit holds with parallel requests and across instances: 5 per email per rolling minute, failures included, 6th gets 429 with `Retry-After`. Idempotent replays are not counted as new attempts.

## Notes
The web page has the API key injected so it works out of the box. That is fine for a demo; a real clinic would put a backend-for-frontend or user login in front of the API.
