/**
 * Describe a photo/video message without downloading it. The descriptor keeps just enough to fetch
 * the media later (when the reseller approves it), so nothing heavy sits in memory or the database.
 * `sha` is WhatsApp's own SHA-256 of the file, so identical images forwarded by different vendors
 * (or re-posted) share a fingerprint, with no download and no image processing.
 */
export interface MediaDescriptor {
  type: 'image' | 'video';
  mimetype: string;
  sha: string;            // base64 SHA-256 of the unencrypted file ('' if WhatsApp didn't send it)
  mediaKey: string;       // base64
  directPath: string;
  url: string;
  fileEncSha256: string;  // base64
  fileLength: number;
  width?: number;
  height?: number;
  seconds?: number;
}

const b64 = (v: unknown): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return '';
};

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'toNumber' in (v as object)) return (v as { toNumber(): number }).toNumber();
  return Number(String(v)) || 0;
};

export function mediaOf(content: any): MediaDescriptor | null {
  const img = content?.imageMessage;
  const vid = content?.videoMessage;
  const m = img ?? vid;
  if (!m) return null;
  return {
    type: img ? 'image' : 'video',
    mimetype: m.mimetype ?? (img ? 'image/jpeg' : 'video/mp4'),
    sha: b64(m.fileSha256),
    mediaKey: b64(m.mediaKey),
    directPath: m.directPath ?? '',
    url: m.url ?? '',
    fileEncSha256: b64(m.fileEncSha256),
    fileLength: num(m.fileLength),
    width: num(m.width) || undefined,
    height: num(m.height) || undefined,
    seconds: img ? undefined : num(m.seconds) || undefined,
  };
}

/** WhatsApp's album header: how many photos/videos to expect, so a group can close early. */
export function albumExpected(content: any): number | null {
  const a = content?.albumMessage;
  if (!a) return null;
  const n = num(a.expectedImageCount) + num(a.expectedVideoCount);
  return n > 0 ? n : null;
}
