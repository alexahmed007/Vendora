# reseller-bot (stage 1: multi-tenant core)

One process, one WhatsApp session per customer ("tenant"). Built on the old bot's store/plugin ideas,
without the economy/games, and without single-tenant globals.

## Run
    cp .env.example .env            # set ONE database URL (Mongo / Postgres / MySQL / SQLite), or leave blank for JSON files
    npm install --legacy-peer-deps  # (add --omit=optional to skip DB drivers you don't use)
    npm run build
    npm run cli -- add acme 2348012345678 "Acme Fashion" 30   # id, number, label, trial days
    npm start                                                  # prints a pairing code for each pending tenant
Then on the customer's phone: WhatsApp > Linked devices > Link with phone number > enter the code.
Send `.ping` from the linked number to confirm the round trip.

## Layout
    src/core/sessionManager.ts   one socket per tenant, backoff + jitter, safe teardown, pairing, plan enforcement
    src/core/tenantContext.ts    what plugins receive: live getSock(), scoped stores, per-tenant caches
    src/core/dbAuthState.ts      Baileys auth in the DB (strict reads: a DB error can never mint new creds)
    src/core/memoryGuard.ts      soft limit closes admission, hard limit shuts down gracefully
    src/store/pluginStore.ts     your store, with 3 safety patches (see below)
    src/store/tenantStore.ts     tenant isolation by table name (t_<tenant>_<namespace>)
    src/store/tenants.ts         tenant registry (number, plan, expiry, status)

## pluginStore.ts patches vs. the original
1. keyLocks entries are released when their chain ends (it grew by one entry per distinct key, forever).
2. mutate() reads/writes through the adapter so a failed read throws instead of becoming null and overwriting data.
3. patch() likewise.

## Tested here
`npm test` (10 checks, JSON-file backend): isolation, locking, Buffer round-trips, DB-failure behaviour, per-tenant dedupe.
Boot with unreachable WhatsApp: backoff, independent tenants, clean shutdown.

## NOT yet tested (needs a real phone)
Pairing code flow, message round-trip, memory per *online* session.
