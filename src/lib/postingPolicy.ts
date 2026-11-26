/**
 * Pure rules for WHEN a reseller's account may post. Posting like a person is the main defence
 * against WhatsApp flagging the number: steady gaps, a daily ceiling, a slow ramp-up for new
 * accounts, and quiet hours. Time is always passed in, so every rule is unit-testable.
 */

const DAY_MS = 86_400_000;

/** A new account starts at 10 posts a day and adds 10 per day, up to the reseller's own ceiling. */
export function dailyLimit(input: { dailyCap: number; createdAt: number; now: number }): number {
  const ageDays = Math.max(0, Math.floor((input.now - input.createdAt) / DAY_MS));
  return Math.max(1, Math.min(input.dailyCap, 10 + ageDays * 10));
}

/** Calendar day (YYYY-MM-DD) and hour (0-23) in the given time zone. */
export function localParts(ts: number, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Quiet window [start, end) in local hours; wraps past midnight (23 to 6). start === end turns it off. */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** A random pause between two posts, in ms. */
export function nextGapMs(minSec: number, maxSec: number, rand: () => number = Math.random): number {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  return Math.round((lo + rand() * (hi - lo)) * 1000);
}

export type BlockReason = 'paused' | 'cooldown' | 'quiet' | 'cap' | 'gap';
export type Verdict = { ok: true } | { ok: false; reason: BlockReason };

export interface SendCheck {
  enabled: boolean;
  now: number;
  timeZone: string;
  createdAt: number;
  sentToday: number;
  dailyCap: number;
  quietStart: number;
  quietEnd: number;
  nextSendAt: number;
  /** Set after errors that suggest WhatsApp is pushing back: no sending until then. */
  pausedUntil: number;
}

export function canSendNow(c: SendCheck): Verdict {
  if (!c.enabled) return { ok: false, reason: 'paused' };
  if (c.pausedUntil > c.now) return { ok: false, reason: 'cooldown' };
  if (inQuietHours(localParts(c.now, c.timeZone).hour, c.quietStart, c.quietEnd)) return { ok: false, reason: 'quiet' };
  if (c.sentToday >= dailyLimit({ dailyCap: c.dailyCap, createdAt: c.createdAt, now: c.now })) return { ok: false, reason: 'cap' };
  if (c.nextSendAt > c.now) return { ok: false, reason: 'gap' };
  return { ok: true };
}
