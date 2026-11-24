import { definePlugin } from '../core/plugin.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { appCtxFrom, askNumber, askText, go, runApp, stay, type ScreenMap } from '../ui/appUi.js';

/**
 * The reseller dashboard. Stage 2 ships Home and Settings; vendors, queue, pricing rules and
 * AI customer care add their own screens here in later stages.
 */
const screens: ScreenMap = {
  home: {
    async view({ ctx }) {
      const s = await getSettings(ctx);
      return {
        title: s.brandName || 'Reseller dashboard',
        subtitle: 'Control panel',
        text: [
          `Status: ${ctx.online ? '✅ connected' : '⚠️ reconnecting'}`,
          `Default markup: ${s.markupPercent}%`,
          `Contact line: ${s.contactLine || '_not set_'}`,
        ].join('\n'),
        options: [
          { label: '⚙️ Settings', value: 'settings', description: 'Brand name, contact line, markup' },
          { label: '🔄 Refresh', value: 'refresh' },
        ],
      };
    },
    select: (value) => (value === 'settings' ? go('settings') : stay()),
  },

  settings: {
    async view({ ctx }) {
      const s = await getSettings(ctx);
      return {
        title: 'Settings',
        text: `Brand: ${s.brandName || '_not set_'}\nContact line: ${s.contactLine || '_not set_'}\nMarkup: ${s.markupPercent}%`,
        options: [
          { label: '🏷️ Brand name', value: 'brand', description: 'Shown on your posts' },
          { label: '📞 Contact line', value: 'contact', description: 'Replaces the vendor’s number in captions' },
          { label: '💹 Default markup %', value: 'markup', description: 'Added to vendor prices' },
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
        default:
          return stay();
      }
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
      cooldownMs: 3_000,
      run: async (c) => {
        await runApp(appCtxFrom(c), screens, 'home');
      },
    },
  ],
});
