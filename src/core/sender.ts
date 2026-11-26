import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import type { MediaDescriptor } from '../lib/mediaInfo.js';
import type { TenantContext } from './tenantContext.js';

/** What went wrong, in the terms the publisher needs to decide what to do next. */
export class PostError extends Error {
  constructor(
    message: string,
    /** permanent: don't retry · ratelimit: WhatsApp is pushing back, stop for a while · transient: try again later */
    readonly kind: 'permanent' | 'ratelimit' | 'transient',
  ) {
    super(message);
  }
}

export interface PostPayload {
  media: MediaDescriptor[];
  caption: string;
}

export interface Sender {
  /** Send an item to a group. Returns the WhatsApp message ids. */
  sendGroup(ctx: TenantContext, jid: string, payload: PostPayload): Promise<string[]>;
  /** Post an item to the reseller's status (first photo/video only). */
  sendStatus(ctx: TenantContext, audience: string[], payload: PostPayload): Promise<string[]>;
}

export interface SenderDeps {
  /** Fetch a media file's bytes. Default: download from WhatsApp using the stored descriptor. */
  download?: (d: MediaDescriptor) => Promise<Buffer>;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function downloadFromWhatsApp(d: MediaDescriptor): Promise<Buffer> {
  const cap = d.type === 'video' ? config.maxVideoBytes : config.maxImageBytes;
  if (d.fileLength > cap) throw new PostError(`media too large (${Math.round(d.fileLength / 1024 / 1024)}MB)`, 'permanent');
  if (!d.mediaKey || !d.directPath) throw new PostError('media details missing', 'permanent');
  try {
    const stream = await downloadContentFromMessage(
      { mediaKey: Buffer.from(d.mediaKey, 'base64'), directPath: d.directPath, url: d.url || undefined },
      d.type,
    );
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > cap) throw new PostError('media too large', 'permanent');
      chunks.push(chunk);
    }
    if (total === 0) throw new PostError('media came back empty', 'permanent');
    return Buffer.concat(chunks);
  } catch (err) {
    if (err instanceof PostError) throw err;
    const msg = (err as Error).message ?? String(err);
    // WhatsApp keeps media for a limited time; 404/410 means it has been deleted.
    if (/\b(404|410)\b|expired|not found|gone/i.test(msg)) throw new PostError('the photo/video has expired on WhatsApp', 'permanent');
    throw new PostError(`download failed: ${msg}`, 'transient');
  }
}

/** One download + send at a time across ALL tenants, so memory stays flat on a small host. */
let gate: Promise<unknown> = Promise.resolve();
function throughGate<T>(work: () => Promise<T>): Promise<T> {
  const run = gate.then(work, work);
  gate = run.catch(() => undefined);
  return run;
}

/** Turn a Baileys / network error into a PostError. */
export function classifySendError(err: unknown): PostError {
  if (err instanceof PostError) return err;
  const e = err as { message?: string; output?: { statusCode?: number }; data?: number };
  const msg = e?.message ?? String(err);
  const code = e?.output?.statusCode ?? e?.data;
  if (code === 429 || /rate-overlimit|too many|429/i.test(msg)) return new PostError(`WhatsApp rate limit: ${msg}`, 'ratelimit');
  if (code === 403 || /forbidden|not-authorized|not a participant|403/i.test(msg)) return new PostError(`not allowed to post there: ${msg}`, 'permanent');
  return new PostError(msg, 'transient');
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function makeSender(deps: SenderDeps = {}): Sender {
  const download = deps.download ?? downloadFromWhatsApp;
  const sleep = deps.sleep ?? realSleep;
  const rand = deps.rand ?? Math.random;

  const content = (d: MediaDescriptor, bytes: Buffer, caption: string | undefined) =>
    d.type === 'video' ? { video: bytes, mimetype: d.mimetype, caption } : { image: bytes, mimetype: d.mimetype, caption };

  return {
    sendGroup: (ctx, jid, payload) =>
      throughGate(async () => {
        const sock = ctx.getSock();
        const ids: string[] = [];
        try {
          if (payload.media.length === 0) {
            const sent = await sock.sendMessage(jid, { text: payload.caption });
            return sent?.key?.id ? [sent.key.id] : [];
          }
          const media = payload.media.slice(0, config.maxMediaPerPost);
          for (let i = 0; i < media.length; i++) {
            if (i > 0) await sleep(2_000 + Math.round(rand() * 2_500)); // a person doesn't fire photos at the same instant
            const bytes = await download(media[i]);
            const sent = await sock.sendMessage(jid, content(media[i], bytes, i === 0 ? payload.caption || undefined : undefined));
            if (sent?.key?.id) ids.push(sent.key.id);
          }
          return ids;
        } catch (err) {
          const e = classifySendError(err);
          // Part of the item may already be out; keep the ids so the product can still be matched to replies.
          (e as PostError & { partialIds?: string[] }).partialIds = ids;
          throw e;
        }
      }),

    sendStatus: (ctx, audience, payload) =>
      throughGate(async () => {
        if (audience.length === 0) throw new PostError('no one to show your status to yet', 'permanent');
        const sock = ctx.getSock();
        try {
          const first = payload.media[0];
          const message = first
            ? content(first, await download(first), cut(payload.caption, 600) || undefined)
            : { text: cut(payload.caption, 600), backgroundColor: '#128C7E', font: 1 };
          const sent = await sock.sendMessage('status@broadcast', message, { statusJidList: audience });
          return sent?.key?.id ? [sent.key.id] : [];
        } catch (err) {
          throw classifySendError(err);
        }
      }),
  };
}
