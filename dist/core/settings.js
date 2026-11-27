export const DEFAULT_SETTINGS = {
    brandName: '',
    contactLine: '',
    markupPercent: 0,
    roundingStep: 100,
    currencySymbol: '₦',
    postingEnabled: true,
    postToStatus: false,
    autoPost: false,
    autoPostDelayMin: 5,
    autoPostMaxAgeHrs: 12,
    dailyCap: 40,
    gapMinSec: 45,
    gapMaxSec: 120,
    quietStart: 23,
    quietEnd: 6,
    aiMode: 'off',
    aiReplyInGroups: true,
    aiReplyToStatus: true,
    aiAwayDelaySec: 90,
    aiOwnerQuietMin: 30,
    aiDailyCap: 150,
    hoursStart: 8,
    hoursEnd: 21,
    shopInfo: '',
    aiInstructions: '',
};
export async function getSettings(ctx) {
    const saved = await ctx.store('settings').get('main');
    return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}
export async function updateSettings(ctx, patch) {
    await ctx.store('settings').patch('main', patch);
}
