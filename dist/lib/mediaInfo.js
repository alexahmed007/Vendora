const b64 = (v) => {
    if (!v)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return Buffer.from(v).toString('base64');
    return '';
};
const num = (v) => {
    if (v === null || v === undefined)
        return 0;
    if (typeof v === 'number')
        return v;
    if (typeof v === 'object' && 'toNumber' in v)
        return v.toNumber();
    return Number(String(v)) || 0;
};
export function mediaOf(content) {
    const img = content?.imageMessage;
    const vid = content?.videoMessage;
    const m = img ?? vid;
    if (!m)
        return null;
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
export function albumExpected(content) {
    const a = content?.albumMessage;
    if (!a)
        return null;
    const n = num(a.expectedImageCount) + num(a.expectedVideoCount);
    return n > 0 ? n : null;
}
