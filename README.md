# reseller-bot (stages 1-3: multi-tenant core, plugins, dashboard, vendor ingestion)

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
    .admin                       # numbered admin menu: Customers / Add customer / System (opens in your own chat)
    .admin list | status | pause <id> | resume <id> | extend <id> <days> | restart <id>   # text versions
    .menu                        # each reseller's dashboard: Items, Vendor groups, Settings
    .source add | remove | list  # type in a vendor's group to make it a source
    .ping  .help

## How vendor posts become items (stage 3)
1. In a wholesale vendor's group, type `.source add`. (Typed anywhere, `.source list` shows your sources.)
2. New posts there are collected per vendor: photos/videos + caption (also a caption sent after the photos) become one item.
   Products posted back to back (even forwarded 1s apart, each with its own caption) are split; an album header closes a group early. Waits ALBUM_QUIET_MS (20s) for stragglers.
3. The price is read from the caption: ₦ # N NGN $ k, "price"/"each", dot style "8.000", plain "8,000", or just a number at the end of an "item name 8000" line. Sizes, quantities, years, % and phone numbers are not prices.
   Wholesale beats retail; "was" and ~struck~ prices are ignored. No price or a shaky guess flags the item for review.
4. A re-posted photo (same WhatsApp file hash) updates the existing item instead of duplicating it; a quoted "sold out" marks it sold out.
5. `.menu` -> Items shows "vendor price -> your price" and exactly what customers will see: vendor phone numbers, links, handles and
   promo lines removed, every price replaced by yours, your contact line added. Rendered from your CURRENT settings.
Nothing is posted yet (stage 4). Photos are never stored: only descriptors, to download when you approve. Items older than 30 days are pruned.

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
    src/lib/                     pure logic, no WhatsApp/DB: priceParser, captionCleaner, pricingEngine, albumGrouper, stockSignals, mediaInfo
    src/core/catalog.ts vendors.ts render.ts settings.ts    items, vendor sources, caption/price preview, per-reseller settings
    src/plugins/                 core, admin (menu), menu (dashboard), ingest (vendor posts). Add a file here to add a plugin.
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
- Buttons are for the *recipient* of a message. The bot is the owner's own account, so any menu the owner must answer
  (own chat or a group) is numbered text; buttons are only used when someone else (a customer) answers.
  MENU_MODE=buttons forces buttons everywhere (they will look fine and do nothing for the owner).
- `.menu` and `.admin` always answer in the owner's own chat, even when typed in a group, so private settings
  and customer lists are never posted to other people.
- Tap does nothing? Set MENU_DEBUG=true and watch the log, or look for "a reply targets a pending menu but no choice could be read".

## Tests
    npm test    # build + 10 store/auth checks, 17 router/host/menu checks, 16 parsing/ingestion/dashboard/admin checks
                # (fake sockets + local JSON files; refuses to run if a DB URL is set, ignores .env)

## Not yet tested (needs a real phone)
Pairing code flow, real message round trips, real vendor message shapes (album headers, file hashes), memory per *online* session.
Please send me captions your vendors really use that the preview gets wrong.
