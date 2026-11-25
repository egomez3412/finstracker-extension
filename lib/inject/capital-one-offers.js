// Injected into the issuer's rendered offer feed; no private endpoints or session data.
export async function capitalOneOffersPageScraper(sweep = false) {
    const collected = new Map();
    const pause = () => new Promise(resolve => setTimeout(resolve, 250));
    const badgePattern = /(?:up to\s+)?\d+(?:\.\d+)?%\s*back|(?:up to\s+)?\$[\d,.]+\s*back|earn\s*\$[\d,.]+/i;
    const amount = s => Math.round(Number(String(s).replace(/[^\d.]/g, '')) * 100);
    const key = o => `${o.merchant.toLowerCase()}|${o.redemptionMethod}|${o.discountType}|${o.discountValue}|${o.minSpendCents}`;
    function offerFrom(tile, mode, activated, slots) {
        const logo = tile.querySelector('img[src*="/logos?"][alt]') || tile.querySelector('img[alt]');
        const merchant = logo?.alt?.trim();
        const text = (tile.innerText || tile.textContent || '').replace(/\s+/g, ' ').trim();
        const badge = text.match(badgePattern)?.[0];
        if (!merchant || merchant.length > 120 || !badge) return null;
        const pct = badge.match(/([\d.]+)%/);
        const minimum = text.match(/spend\s*\$([\d,.]+)/i);
        const minSpendCents = minimum ? amount(minimum[1]) : 0;
        const discountValue = pct ? Number(pct[1]) : amount(badge);
        const remainingDays = activated && text.match(/(\d+) days? left/i);
        const today = new Date();
        const expiry = remainingDays ? new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(remainingDays[1])).toISOString() : null;
        return {
            merchant, title: `${merchant} – ${badge}`,
            description: `${text}. ${mode === 'shopping_link' ? 'Open this offer in Capital One Offers and follow its shopping link before purchasing. Rates and exclusions vary.' : 'Activate this offer in Capital One Offers before purchasing. Capital One limits simultaneous card-linked activations.'}`.slice(0, 500),
            redemptionMethod: mode, discountUpTo: /\bup to\b/i.test(badge),
            discountType: pct ? 'pct_back' : 'statement_credit', discountValue,
            valueCents: pct ? Math.round((minSpendCents || 5000) * discountValue / 100) : discountValue,
            minSpendCents, expiresAt: expiry, merchantUrl: 'https://capitaloneoffers.com/feed', category: 'other',
            activated, activationVerified: activated,
            ...(mode === 'card_linked' && slots ? { activationLimit: Number(slots[2]), activationRemaining: Number(slots[2]) - Number(slots[1]) } : {}),
        };
    }
    function read() {
        const heading = [...document.querySelectorAll('h2')].find(el => el.textContent.trim() === 'Added to Card');
        const enrolled = heading?.parentElement?.parentElement;
        const slots = heading?.parentElement?.textContent.match(/(\d+) of (\d+) activated\b/i);
        const confirmed = new Map();
        // Only the explicit issuer "Added to Card" collection confirms activation.
        if (enrolled) for (const tile of enrolled.querySelectorAll('.standard-tile')) {
            const active = offerFrom(tile, 'card_linked', true, slots);
            if (active) { confirmed.set(key(active), active); collected.set(key(active), active); }
        }
        // The horizontal shopping collection has ordinary logo tiles without
        // individual encoded IDs. It does not consume card-linked slots.
        for (const tile of document.querySelectorAll('[data-testid^="feed-tile-carousel-"] .standard-tile')) {
            const offer = offerFrom(tile, 'shopping_link', false, null);
            if (offer && !/in-store|at the pump/i.test(tile.textContent || '')) collected.set(key(offer), offer);
        }
        for (const tile of document.querySelectorAll('[data-testid^="feed-tile-"]')) {
            let metadata;
            try { metadata = JSON.parse(atob(tile.getAttribute('data-testid').slice('feed-tile-'.length).replace(/-/g, '+').replace(/_/g, '/'))); } catch { continue; }
            // Read only the UI's offer-kind marker. Never save the opaque view context.
            const kinds = metadata?.offers || [];
            if (!kinds.includes('affiliate') && !kinds.includes('cardLinked')) continue;
            const mode = kinds.includes('cardLinked') ? 'card_linked' : 'shopping_link';
            const offer = offerFrom(tile, mode, false, slots);
            if (!offer) continue;
            offer.activationVerified = mode === 'card_linked' && Boolean(slots) && confirmed.size === Number(slots[1]);
            collected.set(key(offer), confirmed.get(key(offer)) || offer);
        }
    }
    read();
    if (!sweep) return [...collected.values()];
    const scroller = document.scrollingElement || document.documentElement;
    const original = scroller.scrollTop;
    let loads = 0;
    scroller.scrollTop = 0;
    await pause();
    for (let pass = 0; pass < 250; pass++) {
        read();
        const more = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'View More Offers' && !b.disabled);
        const r = more?.getBoundingClientRect();
        if (more && r.height > 0 && r.top < (scroller.clientHeight || 800) + 100 && loads < 20) {
            const previousCount = collected.size, previousHeight = scroller.scrollHeight;
            more.click(); loads++;
            for (let poll = 0; poll < 20; poll++) {
                await pause(); read();
                if (collected.size > previousCount || scroller.scrollHeight > previousHeight || !more.isConnected) break;
            }
            continue;
        }
        const next = Math.min(scroller.scrollTop + Math.max(300, (scroller.clientHeight || 800) * 0.7), scroller.scrollHeight - scroller.clientHeight);
        if (next <= scroller.scrollTop) break;
        scroller.scrollTop = next;
        await pause();
    }
    read();
    scroller.scrollTop = original;
    return [...collected.values()];
}
