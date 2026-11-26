import { approveItems } from '../core/approve.js';
import { countByStatus, getProduct, listProducts, saveProduct } from '../core/catalog.js';
import { queueSummary } from '../core/publisher.js';
import { definePlugin } from '../core/plugin.js';
import { renderProduct } from '../core/render.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { getVendor, listVendors, removeVendor, saveVendor } from '../core/vendors.js';
import { formatMoney } from '../lib/pricingEngine.js';
import { appCtxFrom, askNumber, askText, askValue, back, go, replace, runApp, stay, type ScreenMap } from '../ui/appUi.js';
import { publishScreens } from '../ui/publishScreens.js';

/** The reseller's dashboard: items from vendors, vendor groups, and settings. Numbered, in their own chat. */
const PAGE = 6;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const screens: ScreenMap = {
  ...publishScreens,
  // ── home ──────────────────────────────────────────────────────────────────
  home: {
    async view({ ctx }) {
      const [s, counts, vendors, q] = await Promise.all([getSettings(ctx), countByStatus(ctx), listVendors(ctx), queueSummary(ctx)]);
      return {
        title: s.brandName || 'Reseller dashboard',
        subtitle: 'Control panel',
        text: [
          `Status: ${ctx.online ? '✅ connected' : '⚠️ reconnecting'}`,
          `Vendor groups: ${vendors.length} · New items: ${counts.new} · Posted: ${counts.posted}`,
          `Posting: ${q.enabled ? '✅ on' : '⏸️ paused'} · today ${q.sentToday}/${q.limitToday} · ${q.pending} in queue${q.failed ? ` · ❌ ${q.failed} failed` : ''}`,
          `Default markup: ${s.markupPercent}% · Contact line: ${s.contactLine || '_not set_'}`,
        ].join('\n'),
        options: [
          { label: `📦 Items (${counts.new} new)`, value: 'items', description: 'Review what vendors posted' },
          { label: '📣 Posting', value: 'posting', description: 'Where to post, queue, limits, kill switch' },
          { label: '🏪 Vendor groups', value: 'vendors', description: 'Sources, markup per vendor' },
          { label: '⚙️ Settings', value: 'settings', description: 'Brand, contact line, markup, rounding' },
          { label: '🔄 Refresh', value: 'refresh' },
        ],
      };
    },
    select: (value) => (value === 'items' ? go('items', { page: 0 }) : value === 'posting' ? go('posting') : value === 'vendors' ? go('vendors') : value === 'settings' ? go('settings') : stay()),
  },

  // ── items ─────────────────────────────────────────────────────────────────
  items: {
    async view({ ctx }, params: { page: number }) {
      const [settings, all] = await Promise.all([getSettings(ctx), listProducts(ctx, { status: 'new' })]);
      const pages = Math.max(1, Math.ceil(all.length / PAGE));
      const page = Math.min(Math.max(0, params.page), pages - 1);
      const options = [];
      for (const p of all.slice(page * PAGE, page * PAGE + PAGE)) {
        const r = renderProduct(p, settings, await getVendor(ctx, p.vendorChatId));
        const label = r.cost !== null && r.price !== null ? `${formatMoney(r.cost, settings.currencySymbol)} → ${formatMoney(r.price, settings.currencySymbol)}` : '⚠️ no price found';
        options.push({ label: `${label} · ${cut(p.vendorName, 18)}`, value: `p:${p.id}`, description: p.needsReview && r.price !== null ? '⚠️ check the price' : `${p.media.length} photo/video${p.media.length === 1 ? '' : 's'}` });
      }
      if (page > 0) options.push({ label: '⬅️ Previous page', value: `page:${page - 1}`, description: '' });
      if (page < pages - 1) options.push({ label: '➡️ Next page', value: `page:${page + 1}`, description: '' });
      if (all.length > 0) options.push({ label: '✅ Approve all (sure prices only)', value: 'approveall', description: 'Up to 20 at a time' });
      return {
        title: 'New items',
        text: all.length ? `Page ${page + 1} of ${pages} · ${all.length} waiting. Format: vendor price → your price.` : 'Nothing new yet. Add a vendor group under Vendor groups, then new posts show up here.',
        options,
      };
    },
    select(value) {
      if (value.startsWith('page:')) return replace('items', { page: Number(value.slice(5)) });
      if (value.startsWith('p:')) return go('item', { id: value.slice(2) });
      if (value === 'approveall') return go('approveall');
      return stay();
    },
  },

  item: {
    async view({ ctx }, params: { id: string }) {
      const p = await getProduct(ctx, params.id);
      if (!p) return { title: 'Item', text: 'This item is gone.', options: [] };
      const settings = await getSettings(ctx);
      const r = renderProduct(p, settings, await getVendor(ctx, p.vendorChatId));
      const sym = settings.currencySymbol;
      const photos = p.media.filter((m) => m.type === 'image').length;
      const videos = p.media.length - photos;
      const options = [
        { label: '✅ Approve and post', value: 'approve', description: 'Queued, posted gradually' },
        { label: '💰 Set my own price', value: 'price' },
        ...(p.manualPrice !== null ? [{ label: '↩️ Use my markup again', value: 'auto' }] : []),
        { label: '🚫 Ignore', value: 'ignore', description: 'Hide this item' },
      ];
      return {
        title: `${p.vendorName}`,
        text: [
          `📷 ${photos} photo${photos === 1 ? '' : 's'}${videos ? ` · 🎥 ${videos} video${videos === 1 ? '' : 's'}` : ''}${p.reposts ? ` · re-posted ${p.reposts}×` : ''}`,
          r.cost !== null && r.price !== null ? `Cost ${formatMoney(r.cost, sym)} → you sell at ${formatMoney(r.price, sym)}${p.manualPrice !== null ? ' (your price)' : ''}` : '⚠️ No price found in this post. Set your own price.',
          p.needsReview && r.price !== null ? '⚠️ I wasn’t sure about this price, please check it.' : '',
          '',
          '*What your customers will see:*',
          cut(r.caption || '(no caption)', 700),
        ].filter((x, i) => x !== '' || i === 2).join('\n'),
        options,
      };
    },
    async select(value, app, params: { id: string }) {
      const p = await getProduct(app.ctx, params.id);
      if (!p) return back();
      switch (value) {
        case 'approve': {
          const r = await approveItems(app.ctx, [p.id]);
          app.notice = r.queuedItems
            ? '✅ Approved and queued. I’ll post it gradually.'
            : r.noTargets
              ? '✅ Approved. But you haven’t chosen where to post yet: Posting → Groups to post to.'
              : '✅ Approved.';
          return back();
        }
        case 'ignore':
          p.status = 'ignored';
          await saveProduct(app.ctx, p);
          app.notice = '🚫 Ignored.';
          return back();
        case 'price': {
          const v = await askNumber(app, 'Your selling price for this item (a number, e.g. 15000):', 1, 1_000_000_000);
          if (v === null) return stay('Cancelled.');
          p.manualPrice = v;
          await saveProduct(app.ctx, p);
          return stay('✅ Price set.');
        }
        case 'auto':
          p.manualPrice = null;
          await saveProduct(app.ctx, p);
          return stay('↩️ Back to your markup.');
        default:
          return stay();
      }
    },
  },

  // ── vendor groups ─────────────────────────────────────────────────────────
  vendors: {
    async view({ ctx }) {
      const all = await listVendors(ctx);
      return {
        title: 'Vendor groups',
        text: all.length ? 'Pick one to change its markup or remove it.\nTo add another: open the vendor’s group and type *.source add*.' : 'No vendor groups yet.\nOpen a wholesale vendor’s group and type *.source add*.',
        options: all.map((v) => ({ label: `🏪 ${cut(v.name, 30)}${v.enabled ? '' : ' (off)'}`, value: `v:${v.chatId}`, description: v.markupPercent !== null ? `markup ${v.markupPercent}%` : 'default markup' })),
      };
    },
    select: (value) => (value.startsWith('v:') ? go('vendor', { chatId: value.slice(2) }) : stay()),
  },

  vendor: {
    async view({ ctx }, params: { chatId: string }) {
      const v = await getVendor(ctx, params.chatId);
      if (!v) return { title: 'Vendor', text: 'This vendor group was removed.', options: [] };
      const s = await getSettings(ctx);
      return {
        title: v.name,
        text: [
          `Status: ${v.enabled ? '✅ importing' : '⏸️ off'}`,
          `Markup: ${v.markupPercent !== null ? `${v.markupPercent}% (just for this vendor)` : `${s.markupPercent}% (your default)`}`,
          `Watermark text removed: ${v.stripPhrases.length ? v.stripPhrases.map((x) => `“${cut(x, 24)}”`).join(', ') : 'none'}`,
        ].join('\n'),
        options: [
          { label: '✏️ Markup for this vendor', value: 'markup', description: 'Send a number, or "default"' },
          { label: v.enabled ? '⏸️ Stop importing' : '▶️ Start importing', value: 'toggle' },
          { label: '🧼 Remove watermark text', value: 'strip', description: 'A slogan or name vendors add' },
          ...(v.stripPhrases.length ? [{ label: '🧽 Clear watermark list', value: 'clearstrip' }] : []),
          { label: '🗑️ Remove this vendor', value: 'remove' },
        ],
      };
    },
    async select(value, app, params: { chatId: string }) {
      const v = await getVendor(app.ctx, params.chatId);
      if (!v) return back();
      switch (value) {
        case 'markup': {
          const n = await askValue<number | 'default'>(app, {
            prompt: 'Markup % for this vendor (0 to 500), or send *default* to use your general markup.',
            hint: 'Send a number between 0 and 500, or "default".',
            parse: (t) => {
              if (/^default$/i.test(t)) return 'default';
              const x = Number(t.replace(/[%\s]/g, ''));
              return Number.isFinite(x) && x >= 0 && x <= 500 ? x : null;
            },
          });
          if (n === null) return stay('Cancelled.');
          await saveVendor(app.ctx, { ...v, markupPercent: n === 'default' ? null : n });
          return stay(n === 'default' ? '✅ Using your default markup.' : `✅ Markup for this vendor: ${n}%.`);
        }
        case 'toggle':
          await saveVendor(app.ctx, { ...v, enabled: !v.enabled });
          return stay(v.enabled ? '⏸️ Stopped importing from this group.' : '▶️ Importing again.');
        case 'strip': {
          const phrase = await askText(app, 'Send the exact text to remove from this vendor’s captions (e.g. their slogan):', 80);
          if (!phrase) return stay('Cancelled.');
          await saveVendor(app.ctx, { ...v, stripPhrases: [...new Set([...v.stripPhrases, phrase])] });
          return stay('✅ I’ll remove that text from now on.');
        }
        case 'clearstrip':
          await saveVendor(app.ctx, { ...v, stripPhrases: [] });
          return stay('🧽 Cleared.');
        case 'remove':
          await removeVendor(app.ctx, v.chatId);
          app.notice = '🗑️ Vendor removed.';
          return back();
        default:
          return stay();
      }
    },
  },

  // ── settings ──────────────────────────────────────────────────────────────
  settings: {
    async view({ ctx }) {
      const s = await getSettings(ctx);
      return {
        title: 'Settings',
        text: [
          `Brand: ${s.brandName || '_not set_'}`,
          `Contact line: ${s.contactLine || '_not set_'}`,
          `Default markup: ${s.markupPercent}%`,
          `Round prices up to: ${s.roundingStep ? formatMoney(s.roundingStep, s.currencySymbol) : 'no rounding'}`,
          `Currency symbol: ${s.currencySymbol}`,
        ].join('\n'),
        options: [
          { label: '🏷️ Brand name', value: 'brand', description: 'Shown on your dashboard' },
          { label: '📞 Contact line', value: 'contact', description: 'Replaces the vendor’s number in captions' },
          { label: '💹 Default markup %', value: 'markup', description: 'Added to vendor prices' },
          { label: '🔢 Price rounding', value: 'rounding', description: 'e.g. always end in 00' },
          { label: '💱 Currency symbol', value: 'currency', description: 'For prices with no symbol' },
        ],
      };
    },
    async select(value, app) {
      switch (value) {
        case 'brand': {
          const v = await askText(app, 'What is your brand name?', 60);
          if (v === null) return stay('Cancelled.');
          await updateSettings(app.ctx, { brandName: v });
          return stay('✅ Brand name saved.');
        }
        case 'contact': {
          const v = await askText(app, 'Send the contact line customers should see (e.g. "Order: 0801 234 5678"):', 120);
          if (v === null) return stay('Cancelled.');
          await updateSettings(app.ctx, { contactLine: v });
          return stay('✅ Contact line saved.');
        }
        case 'markup': {
          const v = await askNumber(app, 'Default markup in percent (0 to 500). Example: 15', 0, 500);
          if (v === null) return stay('Cancelled.');
          await updateSettings(app.ctx, { markupPercent: v });
          return stay(`✅ Markup set to ${v}%.`);
        }
        case 'rounding':
          return go('rounding');
        case 'currency': {
          const v = await askText(app, 'Send the currency symbol (e.g. ₦ or $ or GH₵):', 4);
          if (v === null) return stay('Cancelled.');
          await updateSettings(app.ctx, { currencySymbol: v });
          return stay(`✅ Currency symbol: ${v}`);
        }
        default:
          return stay();
      }
    },
  },

  rounding: {
    view: () => ({
      title: 'Price rounding',
      text: 'Round every selling price UP to a multiple of:',
      options: [0, 50, 100, 500, 1000].map((n) => ({ label: n === 0 ? 'No rounding' : `${n}`, value: `r:${n}` })),
    }),
    async select(value, app) {
      if (!value.startsWith('r:')) return stay();
      const step = Number(value.slice(2));
      await updateSettings(app.ctx, { roundingStep: step });
      app.notice = step ? `✅ Prices round up to a multiple of ${step}.` : '✅ Rounding off.';
      return back();
    },
  },
};

export default definePlugin({
  name: 'menu',
  commands: [
    {
      name: 'menu',
      aliases: ['dashboard'],
      description: 'Open your dashboard',
      cooldownMs: 1_000,
      interactive: true,
      run: async (c) => {
        const app = appCtxFrom(c);
        // The dashboard shows private settings and needs typed replies, so it never runs in a group
        // or a customer chat. Typed from anywhere, it opens in the owner's own chat instead.
        if (!c.isOwnChat) {
          app.chatId = c.ownChatId;
          app.message = undefined;
        }
        await runApp(app, screens, 'home');
      },
    },
  ],
});
