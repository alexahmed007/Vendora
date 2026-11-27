import { getProduct, saveProduct } from './catalog.js';
import { enqueueProduct } from './publisher.js';
/** Approve items and queue them for posting. Shared by the item screen and "approve all". */
export async function approveItems(ctx, ids) {
    let approved = 0;
    let queuedItems = 0;
    let noTargets = false;
    for (const id of ids) {
        const p = await getProduct(ctx, id);
        if (!p || (p.status !== 'new' && p.status !== 'approved'))
            continue;
        p.status = 'approved';
        await saveProduct(ctx, p);
        approved++;
        const r = await enqueueProduct(ctx, id);
        if (r.queued > 0)
            queuedItems++;
        if (r.reason === 'no-targets')
            noTargets = true;
    }
    return { approved, queuedItems, noTargets };
}
