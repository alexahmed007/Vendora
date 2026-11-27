import { countByStatus, getProduct, listProducts } from '../core/catalog.js';
import { approveItems } from '../core/approve.js';
import { clearFailed, enqueueApproved, queueSummary, retryFailed } from '../core/publisher.js';
import { listJobs } from '../core/queue.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { getTarget, listTargets, removeTarget, saveTarget } from '../core/targets.js';
import { askNumber, back, go, stay, type ScreenMap } from './appUi.js';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Dashboard screens for posting: where to post, the queue, and the safety limits. */
export const publishScreens: ScreenMap = {
  posting: {
    async view({ ctx }) {
      const [s, q, targets, counts] = await Promise.all([getSettings(ctx), queueSummary(ctx), listTargets(ctx), countByStatus(ctx)]);
      const now = Date.now();
      const on = targets.filter((t) => t.enabled).length;
      const warm = q.limitToday < s.dailyCap;
      const lines = [
        `Posting: ${s.postingEnabled ? '✅ ON' : '⏸️ PAUSED'}${q.pausedUntil > now ? ` · cooling down ${mins(q.pausedUntil - now)} min after errors` : ''}`,
        `Today: ${q.sentToday} of ${q.limitToday} posts${warm ? ' (new account: the limit grows each day)' : ''}`,
        `Queue: ${q.pending} waiting · ${q.failed} failed`,
        `Where: ${on} group${on === 1 ? '' : 's'}${s.postToStatus ? ' + your status' : ''}`,
      ];
      if (q.pending > 0 && q.nextSendAt > now) lines.push(`Next post in about ${Math.max(1, Math.round((q.nextSendAt - now) / 1000))}s`);
      const options = [
        { label: s.postingEnabled ? '⏸️ Pause posting' : '▶️ Resume posting', value: 'toggle', description: 'The kill switch' },
        { label: '👥 Groups to post to', value: 'targets', description: 'Your customer groups' },
        { label: `📱 Status: ${s.postToStatus ? 'ON' : 'OFF'}`, value: 'status', description: 'Also post to your WhatsApp status' },
        { label: '📬 Queue', value: 'queue', description: 'What’s waiting or failed' },
        { label: '⚙️ Limits', value: 'limits', description: 'Daily limit, gaps, quiet hours' },
      ];
      if (counts.approved > 0) options.push({ label: `📥 Queue approved items (${counts.approved})`, value: 'queueapproved', description: 'Approved but not queued yet' });
      if (q.failed > 0) options.push({ label: `🔁 Retry failed (${q.failed})`, value: 'retry', description: '' });
      return { title: 'Posting', text: lines.join('\n'), options };
    },
    async select(value, { ctx }) {
      const s = await getSettings(ctx);
      switch (value) {
        case 'toggle':
          await updateSettings(ctx, { postingEnabled: !s.postingEnabled });
          return stay(s.postingEnabled ? '⏸️ Posting paused. Nothing will be sent.' : '▶️ Posting is on.');
        case 'targets':
          return go('targets');
        case 'status':
          await updateSettings(ctx, { postToStatus: !s.postToStatus });
          return stay(s.postToStatus ? '📱 Status posting off.' : '📱 Status posting on. It shows to people who’ve messaged you and members of your posting groups. Try one item first and check that it appears.');
        case 'queue':
          return go('queue');
        case 'limits':
          return go('limits');
        case 'queueapproved': {
          const r = await enqueueApproved(ctx);
          if (r.reason === 'no-targets') return stay('⚠️ Choose where to post first: Groups to post to, or turn Status on.');
          return stay(`📥 Queued ${r.items} item${r.items === 1 ? '' : 's'}.`);
        }
        case 'retry':
          return stay(`🔁 ${await retryFailed(ctx)} post(s) queued again.`);
        default:
          return stay();
      }
    },
  },

  targets: {
    async view({ ctx }) {
      const all = await listTargets(ctx);
      return {
        title: 'Groups to post to',
        text: all.length
          ? 'Approved items are posted to the groups that are ON.\nTo add another: open the group and type *.target add*.'
          : 'No groups yet.\nOpen one of your customer groups and type *.target add*.',
        options: all.map((t) => ({ label: `📣 ${cut(t.name, 30)}${t.enabled ? '' : ' (off)'}`, value: `t:${t.chatId}` })),
      };
    },
    select: (value) => (value.startsWith('t:') ? go('target', { chatId: value.slice(2) }) : stay()),
  },

  target: {
    async view({ ctx }, params: { chatId: string }) {
      const t = await getTarget(ctx, params.chatId);
      if (!t) return { title: 'Group', text: 'This group was removed.', options: [] };
      return {
        title: t.name,
        text: `Status: ${t.enabled ? '✅ posting here' : '⏸️ off'}`,
        options: [
          { label: t.enabled ? '⏸️ Stop posting here' : '▶️ Post here again', value: 'toggle' },
          { label: '🗑️ Remove this group', value: 'remove' },
        ],
      };
    },
    async select(value, app, params: { chatId: string }) {
      const t = await getTarget(app.ctx, params.chatId);
      if (!t) return back();
      if (value === 'toggle') {
        await saveTarget(app.ctx, { ...t, enabled: !t.enabled });
        return stay(t.enabled ? '⏸️ Paused for this group.' : '▶️ Posting here again.');
      }
      if (value === 'remove') {
        await removeTarget(app.ctx, t.chatId);
        app.notice = '🗑️ Group removed.';
        return back();
      }
      return stay();
    },
  },

  queue: {
    async view({ ctx }) {
      const jobs = (await listJobs(ctx)).filter((j) => j.state === 'pending' || j.state === 'sending' || j.state === 'failed');
      const lines: string[] = [];
      for (const j of jobs.slice(0, 8)) {
        const p = await getProduct(ctx, j.productId);
        const name = cut((p?.rawCaption.split('\n')[0] || 'item').trim(), 28);
        const where = j.target.type === 'group' ? cut(j.target.name, 18) : 'status';
        const mark = j.state === 'failed' ? '❌' : j.state === 'sending' ? '📤' : '⏳';
        lines.push(`${mark} ${name} → ${where}${j.state === 'failed' && j.error ? `\n   ${cut(j.error, 70)}` : ''}`);
      }
      if (jobs.length > 8) lines.push(`…and ${jobs.length - 8} more`);
      const failed = jobs.filter((j) => j.state === 'failed').length;
      const options = [];
      if (failed) options.push({ label: `🔁 Retry failed (${failed})`, value: 'retry' }, { label: '🧹 Clear failed', value: 'clear', description: 'Forget them' });
      return { title: 'Queue', text: lines.length ? lines.join('\n') : 'Nothing waiting.', options };
    },
    async select(value, { ctx }) {
      if (value === 'retry') return stay(`🔁 ${await retryFailed(ctx)} post(s) queued again.`);
      if (value === 'clear') return stay(`🧹 Cleared ${await clearFailed(ctx)}.`);
      return stay();
    },
  },

  limits: {
    async view({ ctx }) {
      const s = await getSettings(ctx);
      const quiet = s.quietStart === s.quietEnd ? 'off' : `${s.quietStart}:00 to ${s.quietEnd}:00`;
      return {
        title: 'Posting limits',
        text: [
          `Daily limit: ${s.dailyCap} posts (new accounts start lower and grow by 10 a day)`,
          `Gap between posts: ${s.gapMinSec}–${s.gapMaxSec} seconds`,
          `Quiet hours: ${quiet}`,
          'Slower is safer. WhatsApp can limit accounts that post too much, too fast.',
        ].join('\n'),
        options: [
          { label: '📊 Daily limit', value: 'cap' },
          { label: '⏱️ Shortest gap (seconds)', value: 'min' },
          { label: '⏱️ Longest gap (seconds)', value: 'max' },
          { label: '🌙 Quiet hours start', value: 'qs', description: 'Hour 0-23' },
          { label: '🌙 Quiet hours end', value: 'qe', description: 'Same as start = off' },
        ],
      };
    },
    async select(value, app) {
      const ask = async (prompt: string, min: number, max: number, key: 'dailyCap' | 'gapMinSec' | 'gapMaxSec' | 'quietStart' | 'quietEnd', done: string) => {
        const n = await askNumber(app, prompt, min, max);
        if (n === null) return stay('Cancelled.');
        await updateSettings(app.ctx, { [key]: Math.round(n) });
        return stay(`✅ ${done} ${Math.round(n)}.`);
      };
      switch (value) {
        case 'cap': return ask('Most posts per day (1 to 300). Lower is safer.', 1, 300, 'dailyCap', 'Daily limit:');
        case 'min': return ask('Shortest gap between posts in seconds (15 to 900).', 15, 900, 'gapMinSec', 'Shortest gap:');
        case 'max': return ask('Longest gap between posts in seconds (15 to 1800).', 15, 1800, 'gapMaxSec', 'Longest gap:');
        case 'qs': return ask('Quiet hours START: an hour from 0 to 23 (e.g. 23).', 0, 23, 'quietStart', 'Quiet hours start:');
        case 'qe': return ask('Quiet hours END: an hour from 0 to 23 (e.g. 6).', 0, 23, 'quietEnd', 'Quiet hours end:');
        default: return stay();
      }
    },
  },

  // Bulk approve: only items with a confident price are included.
  approveall: {
    async view({ ctx }) {
      const fresh = await listProducts(ctx, { status: 'new' });
      const ok = fresh.filter((p) => (p.cost !== null && !p.needsReview) || p.manualPrice !== null).slice(0, 20);
      return {
        title: 'Approve all',
        text: `Approve and queue ${ok.length} item${ok.length === 1 ? '' : 's'}?\nItems where I wasn’t sure of the price (${fresh.length - ok.length > 0 ? fresh.length - ok.length : 0}) stay for you to check one by one.`,
        options: ok.length ? [{ label: `✅ Yes, approve ${ok.length}`, value: 'yes' }] : [],
      };
    },
    async select(value, app) {
      if (value !== 'yes') return stay();
      
      const fresh = await listProducts(app.ctx, { status: 'new' });
      const ok = fresh.filter((p) => (p.cost !== null && !p.needsReview) || p.manualPrice !== null).slice(0, 20);
      const r = await approveItems(app.ctx, ok.map((p) => p.id));
      app.notice = r.noTargets
        ? `✅ Approved ${r.approved}. Choose where to post (Posting → Groups to post to), then Queue approved items.`
        : `✅ Approved ${r.approved} and queued ${r.queuedItems}. They’ll go out gradually.`;
      return back();
    },
  },
};
