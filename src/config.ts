import 'dotenv/config';

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Everything comes from the environment. No API keys, phone numbers or other
 * secrets have defaults here, so nothing sensitive can end up in git.
 */
export const config = {
  port: num(process.env.PORT, 8000),
  prefix: process.env.PREFIX || '.',
  timeZone: process.env.TIMEZONE || 'Africa/Lagos',
  logLevel: process.env.LOG_LEVEL || 'silent',

  // Capacity
  maxSessions: num(process.env.MAX_SESSIONS, 3),
  sessionStartStaggerMs: num(process.env.SESSION_START_STAGGER_MS, 4000),
  memSoftMb: num(process.env.MEM_SOFT_MB, 380),
  memHardMb: num(process.env.MEM_HARD_MB, 460),

  // Presence: the bot must never mark itself "online", or the owner's phone stops
  // receiving push notifications. Escape hatch for plugins that truly need it.
  allowOnlinePresence: process.env.ALLOW_ONLINE_PRESENCE === 'true',
  offlineReassertMs: num(process.env.OFFLINE_REASSERT_MS, 60_000),

  // Per-tenant caches (bounded, so one busy tenant can't eat the heap)
  groupMetaTtlMs: 10 * 60_000,
  groupMetaMax: 300,
  seenMessageTtlMs: 10 * 60_000,
  seenMessageMax: 5_000,
  sentCacheTtlMs: 15 * 60_000,
  sentCacheMax: 200,

  // Pairing
  maxPairAttempts: 3,

  // Plan enforcement sweep
  planSweepMs: 10 * 60_000,
} as const;
