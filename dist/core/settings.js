export const DEFAULT_SETTINGS = { brandName: '', contactLine: '', markupPercent: 0, roundingStep: 100, currencySymbol: '₦' };
export async function getSettings(ctx) {
    const saved = await ctx.store('settings').get('main');
    return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}
export async function updateSettings(ctx, patch) {
    await ctx.store('settings').patch('main', patch);
}
