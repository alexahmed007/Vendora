# reseller-bot (stages 1-2: multi-tenant core, plugins, dashboard)

One process, one WhatsApp session per customer ("tenant"). Built on the old bot's store/plugin ideas,
without the economy/games and without single-tenant globals.

## Run
    cp .env.example .env              # set ONE database URL (or leave blank for JSON files) and ADMIN_NUMBER
    npm install --legacy-peer-deps    # add --omit=optional to skip DB drivers you don't use
    npm run build
    npm run cli -- add control <ADMIN_NUMBER> "Control"    # your own number: the control tenant
    npm start                                              # prints its pairing code to the console
Link it (WhatsApp > Linked devices > Link with phone number). From then on, in your own chat:

    .admin add acme 2348012345678 "Acme Fashion" 30   # id, number, label, trial days
    -> the pairing code arrives in this chat; forward it to the customer to enter on their phone
    .admin list | status | pause <id> | resume <id> | extend <id> <days> | restart <id>
    .menu          # dashboard (any tenant owner, in their own chat)
    .ping  .help

## Layout
    src/core/sessionManager.ts   one socket per tenant: backoff + jitter, safe teardown, pairing, plan enforcement
    src/core/pluginHost.ts       loads plugins (dynamic import), commands, hooks, per-tenant schedules
    src/core/router.ts           messages.upsert -> ordered per-tenant queue, per-tenant dedupe, offline catch-up
    src/core/message.ts          IncomingMessage: unwrapped content, @lid resolution, owner flags, reply()
    src/core/tenantContext.ts    what plugins receive: live getSock(), scoped stores, bounded caches
    src/core/dbAuthState.ts      Baileys auth in the DB (strict reads: a DB error can never mint new creds)
    src/core/memoryGuard.ts      soft limit closes admission, hard limit shuts down gracefully
    src/ui/buttonSession.ts      menu prompts (buttons / dropdown / numbered text), ported + hardened
    src/ui/appUi.ts              screen engine (runApp) + askText / askNumber
    src/plugins/                 core (.ping .help), admin, menu (dashboard). Add a file here to add a plugin.
    src/store/                   pluginStore (patched), tenantStore (table-per-tenant), tenants registry

## Writing a plugin (src/plugins/example.ts)
    export default definePlugin({
      name: 'example', priority: 100,
      commands: [{ name: 'hi', access: 'owner', run: async (c) => { await c.reply('hi'); } }],
      onMessage: async (m) => { /* every non-command message; return true to stop later hooks */ },
      schedules: [{ name: 'sweep', everyMs: 60_000, run: async (ctx) => { /* ctx.store('x'), ctx.getSock() */ } }],
    });

## Behaviours worth knowing
- Customers never reach owner commands: an unauthorised command is ignored and handled as a normal message.
- Messages are processed in arrival order, one at a time per tenant (vendor albums stay in sequence).
- Messages delivered while the bot was offline ("append") are processed if from others and < 6h old, with m.isCatchUp = true.
  Don't auto-reply to catch-up DMs.
- Menus in your own chat are numbered text by default; others get buttons. Set MENU_MODE=buttons after testing.

## Tests
    npm test            # build + 10 store/auth/isolation checks
    node scripts/smoke2.mjs   # 14 router/host/menu/dashboard checks (fake sockets, local JSON files)

## Not yet tested (needs a real phone)
Pairing code flow, real message round trips, buttons rendering in your own chat, memory per *online* session.
