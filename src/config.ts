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

  // The platform admin: the number of the control tenant (yours). Only that tenant's owner
  // can run .admin commands, and pairing codes for new customers are sent to this chat.
  adminNumber: (process.env.ADMIN_NUMBER || '').replace(/\D/g, ''),

  // Router
  commandCooldownMs: num(process.env.COMMAND_COOLDOWN_MS, 1_000),
  handlerTimeoutMs: 60_000,
  // Messages delivered while the bot was offline arrive as "append"; accept recent ones from others.
  catchUpWindowMs: num(process.env.CATCH_UP_WINDOW_MS, 6 * 60 * 60_000),

  // Vendor posts: how long to wait for more photos / a caption before treating an item as complete.
  albumQuietMs: num(process.env.ALBUM_QUIET_MS, 20_000),
  albumBurstMs: num(process.env.ALBUM_BURST_MS, 8_000),
  // Housekeeping for the product catalog
  catalogMaxAgeMs: 30 * 24 * 60 * 60_000,
  catalogMaxItems: 1_500,

  // Posting
  publishTickMs: num(process.env.PUBLISH_TICK_MS, 5_000),
  maxMediaPerPost: num(process.env.MAX_MEDIA_PER_POST, 6),
  maxImageBytes: num(process.env.MAX_IMAGE_MB, 10) * 1024 * 1024,
  maxVideoBytes: num(process.env.MAX_VIDEO_MB, 25) * 1024 * 1024,
  statusAudienceMax: num(process.env.STATUS_AUDIENCE_MAX, 800),

  // AI customer care
  aiMaxConcurrent: num(process.env.AI_MAX_CONCURRENT, 2),
  aiCustomerHourlyCap: num(process.env.AI_CUSTOMER_HOURLY_CAP, 10),
  aiGroupPer10Min: num(process.env.AI_GROUP_PER_10_MIN, 6),
  aiMaxMessageAgeMin: num(process.env.AI_MAX_MESSAGE_AGE_MIN, 30),
  aiSettingsCacheMs: num(process.env.AI_SETTINGS_CACHE_MS, 5_000),

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
