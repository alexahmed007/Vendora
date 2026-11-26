# reseller-bot (stages 1-4: multi-tenant core, dashboard, vendor ingestion, posting)

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
    .target add | remove | list  # type in one of YOUR customer groups to post approved items there
    .post stop | start | status | retry    # kill switch and queue status
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
Photos are never stored: only descriptors, to download when you approve. Items older than 30 days are pruned.

## Posting (stage 4)
Approve an item (`.menu` -> Items) and it is queued for every group set with `.target add`, and for your status if Posting -> Status is on.
- One post at a time per account, a random 45-120s gap after each, a daily limit (default 40; new accounts start at 10/day and grow by 10/day),
  quiet hours (default 23:00-06:00, Africa/Lagos), and a kill switch (`.post stop`, or Posting -> Pause).
- Photos are downloaded from WhatsApp only at posting time, one at a time across all accounts (flat memory), up to 6 per item, caption on the first.
- Retries with back-off; 3 failures in a row pause posting for an hour; a WhatsApp rate-limit pauses it for 2 hours and warns you.
- A crash mid-send never causes a silent double post: the job is marked failed for you to check, then Retry.
- Items that sell out (or whose group was removed) after approval are skipped. Every sent message id is remembered so customer replies can be tied to the product (stage 5).
- Status audience = people who messaged you, contacts WhatsApp announces, and members of your posting groups (WhatsApp gives linked devices no address book). Treat status posting as experimental: try one item and confirm it shows.
- Items with no confident price are skipped by "Approve all"; approve those one by one.

## Layout
    src/core/sessionManager.ts   one socket per tenant: backoff + jitter, safe teardown, pairing, plan enforcement
    src/core/pluginHost.ts       loads plugins (dynamic import), commands, hooks, per-tenant schedules
    src/core/router.ts           messages.upsert -> ordered per-tenant queue, per-tenant dedupe, offline catch-up
    src/core/message.ts          IncomingMessage: unwrapped content, @lid resolution, owner flags, reply()
    src/core/tenantContext.ts    what plugins receive: live getSock(), scoped stores, bounded caches
    src/core/dbAuthState.ts      Baileys auth in the DB (strict reads: a DB error can never mint new creds)
    src/core/memoryGuard.ts      soft limit closes admission, hard limit shuts down gracefully
    src/ui/menuSession.ts        numbered menus in the old bot's USSD style (keycaps, dividers) + free-text prompt styling
    src/ui/appUi.ts              screen engine (runApp) + askText / askNumber
    src/lib/                     pure logic, no WhatsApp/DB: priceParser, captionCleaner, pricingEngine, albumGrouper, stockSignals, mediaInfo
    src/lib/postingPolicy.ts     warm-up ramp, daily cap, quiet hours, gaps (pure)
    src/core/catalog.ts vendors.ts render.ts settings.ts    items, vendor sources, caption/price preview, per-reseller settings
    src/core/queue.ts publisher.ts sender.ts targets.ts audience.ts approve.ts   the posting pipeline
    src/plugins/                 core, admin (menu), menu (dashboard), ingest (vendor posts), publish (posting). Add a file here to add a plugin.
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
- Menus are numbered text (no WhatsApp buttons): reply to the menu with a number, or just type the number; 0 closes. Typed answers to questions
  work either by swipe-replying the question or by typing in the same chat, including when WhatsApp calls your own chat by a LID.
  Reopening `.menu` replaces the old session. Menus and wizards run in the background, so other messages and commands are never held up.
- `.menu` and `.admin` always answer in the owner's own chat, even when typed in a group, so private settings
  and customer lists are never posted to other people.
- A reply ignored? Set MENU_DEBUG=true: the log shows chat id, sender and quoting of every message that arrives while a menu is open.

## Tests
    npm test    # build + 10 store/auth checks, 17 router/host/menu checks, 16 parsing/ingestion/dashboard/admin checks
                # 17 posting checks. (fake sockets + local JSON files; refuses to run if a DB URL is set, ignores .env)

## Not yet tested (needs a real phone)
Real vendor message shapes (album headers, file hashes), downloading and re-sending real photos, status posts actually appearing,
whether WhatsApp tolerates the posting pace on a real number, memory per *online* session.
Please send me captions your vendors really use that the preview gets wrong.
