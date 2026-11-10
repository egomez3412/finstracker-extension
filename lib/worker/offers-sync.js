// Merchant offers for one card: open the issuer's offers page (reusing a tab on the bank's site),
// wait for sign-in, add every offer to the card ("Add to Card"), then save them all to Finstracker
// under that card, marking the ones that are on the card.
import { Tracker } from "../api.js";
import { cardIssuer } from "../programs.js";
import { getState, setState } from "../storage.js";
import { session } from "./account.js";
import { addOffers, findLinkOn, notify, pageSettled, pageStatus, readOffers, showsSignIn, switchAccountOn } from "./tabs.js";
import { urlMatches } from "../portals.js";
import { ensureShownCard, learnPage, learnedPage, portalForCard, withAccount, workTab } from "./sites.js";

// Offers already on the card, listed apart from the ones still to add (Amex moves an offer there
// once it's added). Elsewhere the site's own "Added offers" link is followed.
const ADDED_PAGES = {
    "American Express": "https://global.americanexpress.com/offers/enrolled",
};
const ADDED_WORDS = ["added to card", "added offers", "enrolled offers", "saved offers", "offers added", "my offers"];
// Issuers with one offers page we can open directly. Others use the offers page on screen.
const OFFER_PAGES = {
    "American Express": "https://global.americanexpress.com/offers/eligible",
    Chase: "https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub",
    "Bank of America": "https://secure.bankofamerica.com/customer-deals/redirect/customer-deals.go",
};
// Best first: the list of offers you can still add, then any offers page or tab.
const LINK_WORDS = ["eligible offers", "available offers", "view all offers", "amex offers", "merchant offers", "card offers", "offers for you", "eligible", "offers", "deals"];
// The list of offers you can still add, when the page shows the ones already added.
const ADDABLE_WORDS = ["eligible offers", "available offers", "view all offers", "all offers", "eligible", "available"];
const MAX_HOPS = 4;
const WAIT_MS = 5 * 60 * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const siteName = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global)\./, ""); } catch { return "the site"; } };

export function offersPageFor(card) {
    const issuer = cardIssuer(card);
    if (issuer === "Chase" && card.chaseAccountId) return `${OFFER_PAGES.Chase}?accountId=${encodeURIComponent(card.chaseAccountId)}`;
    return OFFER_PAGES[issuer] || null;
}

/** A one-off sync was cancelled (or replaced) from the panel or the page. */
async function notCurrent(card, kind) {
    const { captureSession } = await getState(["captureSession"]);
    return captureSession?.kind !== kind || captureSession.cardId !== card.id;
}

async function setSession(card, patch) {
    const { captureSession } = await getState(["captureSession"]);
    const base = captureSession?.kind === "offers" && captureSession.cardId === card.id ? captureSession : { kind: "offers", cardId: card.id, cardName: card.displayName, issuer: card.issuer, startedAt: Date.now() };
    await setState({ captureSession: { ...base, expiresAt: Date.now() + WAIT_MS, ...patch } });
}

/** Save offers for a card, 200 at a time (the dashboard's limit per call; saving never removes any). */
async function upload(card, offers) {
    const { apiBase, token } = await session();
    const total = { received: 0, created: 0, updated: 0 };
    for (let i = 0; i < offers.length; i += 200) {
        const r = await Tracker.bulkUpsertOffers(apiBase, token, { cardId: card.id, source: "extension", offers: offers.slice(i, i + 200) });
        total.received += r?.received || 0; total.created += r?.created || 0; total.updated += r?.updated || 0;
    }
    return total;
}

const offerKey = (o) => `${String(o.merchant || "").toLowerCase()}|${o.discountType}|${o.discountValue}`;

/**
 * Every offer from two reads of the page, before and after adding. Sites like Amex take an offer
 * off the list once it's added, so one missing from the second read was added to the card.
 */
export function mergeOffers(before, after, added) {
    const all = new Map((after || []).map((o) => [offerKey(o), o]));
    for (const o of before || []) if (!all.has(offerKey(o))) all.set(offerKey(o), added ? { ...o, activated: true } : o);
    return [...all.values()];
}

/**
 * The list of offers already on the card (Amex's "Added to Card"), read and saved as on the card.
 * Returns how many it saved. Gives up quietly after about 40 seconds.
 */
async function saveAddedList(tab, card, { onHome, account, known, report, stopped }) {
    let page = [ADDED_PAGES[cardIssuer(card)]].find(onHome) || null;
    if (!page) {
        const link = await findLinkOn(tab.id, ADDED_WORDS, []);
        if (link?.href) page = link.href;
        else if (!link?.clicked) return 0;
    }
    await report({ status: "watching", statusLabel: `Reading the offers already on ${card.displayName}…` });
    if (page) await chrome.tabs.update(tab.id, { url: withAccount(page, account) });
    const end = Date.now() + 40000;
    while (Date.now() < end && !stopped()) {
        await pause(1500);
        const info = await chrome.tabs.get(tab.id).catch(() => null);
        if (!info) return 0;
        if (info.status !== "complete") continue;
        await pageSettled(tab.id);
        const onCard = (await readOffers(tab.id)).filter((o) => !known.has(offerKey(o))).map((o) => ({ ...o, activated: true }));
        if (!onCard.length) continue;
        try { await upload(card, onCard); } catch { return 0; }
        return onCard.length;
    }
    return 0;
}

/**
 * Sync offers for a card. tabId: use that tab as it is (Read this tab on an offers page); otherwise
 * reuse a tab on the bank's site or open the issuer's offers page. background: don't focus the tab
 * (autopilot). Returns { ok, kind: "offers", found, added, created, updated }.
 */
export async function syncOffersForCard(card, { tabId = null, navigate = false, background = false, switchTo = null, job = null, account = null } = {}) {
    // Autopilot passes a job: progress goes to its board (several steps run at once in other windows),
    // not to the single sync status the side panel shows for one-off syncs.
    const report = job ? async (patch) => job.report(patch) : (patch) => setSession(card, patch);
    if (!card?.id) return { ok: false, error: "Missing card" };
    const { token } = await session();
    if (!token) return { ok: false, error: "Sign in to Finstracker first", signedOut: true };
    const { addOffersToCard } = await getState(["addOffersToCard"]);
    // Where the offers were found last time, else the issuer's offers page; never a page off the
    // card's own site (a card linked to another site follows that site's links instead).
    const home = await portalForCard(card, { bank: true });
    const onHome = (u) => Boolean(u) && (!home?.matchUrl?.length || urlMatches(home.matchUrl, u));
    // account: the card's own key in the site's addresses (Amex), so this tab shows this card.
    const url = withAccount([await learnedPage(card, "offers"), offersPageFor(card)].find(onHome) || null, account);

    let tab = tabId && !navigate ? await chrome.tabs.get(tabId) : null;
    if (!tab) {
        if (!url && !tabId) {
            const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (!active?.id || !/^https?:/.test(active.url || "")) return { ok: false, error: `Open your ${card.issuer || "card"} offers page first, then choose Sync offers.` };
            tab = active;
        } else {
            // No known offers page: start from the bank's own site (never a co-brand partner's site)
            // and follow its "Offers" link below.
            const bank = await portalForCard(card, { bank: true });
            let start = url;
            if (!start) {
                const current = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
                if (!bank) return { ok: false, error: `No offers page is known for ${card.displayName}. Open it, then choose Read this tab.` };
                start = current && urlMatches(bank.matchUrl, current.url || "") && !/^about:/.test(current.url || "") ? null : withAccount(bank.pointsUrlHint || bank.loginUrl, account);
            }
            tab = await workTab({ tabId, portal: bank, url: start, navigate: Boolean(start), background });
            if (!tab) return { ok: false, error: `Open your ${card.displayName} offers page first, then choose Sync offers.` };
        }
    }
    const tried = [];
    let cardChecks = 0, empty = 0, lookedForAddable = false;
    await report({ tabId: tab.id, status: "opening", statusLabel: `Opening ${card.displayName} offers…`, currentUrl: url || tab.url });

    // A tab the user picked: don't wait long. Autopilot: never more than 3 minutes on one step.
    const deadline = Date.now() + (tabId && !navigate ? 30000 : job ? 3 * 60 * 1000 : WAIT_MS);
    while (Date.now() < deadline) {
        await pause(1500);
        let info;
        try { info = await chrome.tabs.get(tab.id); } catch { return { ok: false, error: "The offers tab was closed" }; }
        if (job ? job.stopped() : await notCurrent(card, "offers")) return { ok: false, error: "Cancelled" };
        if (info.status !== "complete") continue;
        if (await showsSignIn(tab.id)) {
            await report({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(info.url)}` });
            await pageStatus(tab.id, { kind: "busy", title: `Sign in to ${siteName(info.url)}`, text: `Finstracker will add and save your ${card.displayName} offers once you're in.`, actions: [["close", "Cancel"]] });
            if (background) return { ok: false, error: `Sign in to ${siteName(info.url)} first`, needsSignIn: true };
            continue;
        }
        await report({ status: "watching", statusLabel: `Reading ${card.displayName} offers…`, currentUrl: info.url });
        await pageStatus(tab.id, { kind: "busy", title: `Reading your ${card.displayName} offers…` });
        await pageSettled(tab.id);
        let offers = await readOffers(tab.id);
        if (!offers.length) {
            // Not the offers page: follow the site's own Offers link (up to twice). On a page we
            // expected offers on, give it a few looks first (the list loads late).
            empty++;
            await report({ status: "watching", statusLabel: `Looking for ${card.displayName} offers on ${siteName(info.url)}…`, currentUrl: info.url });
            // A page we were sent to gets a few looks first (the list loads late); a page we only
            // passed through (the dashboard) is left at once.
            if (((!url && !tried.length) || empty >= (tried.length ? 2 : 3)) && tried.length < MAX_HOPS) {
                await report({ status: "watching", statusLabel: `Looking around ${siteName(info.url)} for ${card.displayName} offers…`, currentUrl: info.url });
                const link = await findLinkOn(tab.id, LINK_WORDS, tried);
                if (link?.href) { tried.push(link.href); empty = 0; await chrome.tabs.update(tab.id, { url: link.href }); }
                else if (link?.clicked) { tried.push(`text:${link.text}`); empty = 0; await pageSettled(tab.id); }
            }
            continue; // still loading, or on the way to the offers page
        }
        // Several of the user's cards on this site: only offers for the card the page shows.
        const shown = await ensureShownCard(tab.id, card, { siteCards: switchTo?.cards || null, requireVerified: Boolean(switchTo) && !switchTo.ready, attempt: cardChecks++ });
        if (!shown.ok) {
            await report({ status: "error", lastError: shown.message });
            await pageStatus(tab.id, { kind: "error", title: "Offers skipped", text: shown.message, autoHide: 6000 });
            return { ok: false, skipped: true, error: shown.message };
        }
        if (shown.clicked) { await pageSettled(tab.id); continue; }

        // Every offer here is already on the card (the "Added to Card" list): save them, then go to
        // the list of offers that can still be added, when the site has a link or tab for it.
        if (offers.every((o) => o.activated) && !lookedForAddable && tried.length < MAX_HOPS) {
            lookedForAddable = true;
            const link = await findLinkOn(tab.id, ADDABLE_WORDS, tried);
            if (link?.href || link?.clicked) {
                try { await upload(card, offers); } catch { /* saved again below */ }
                await report({ status: "watching", statusLabel: `Opening the ${card.displayName} offers you can still add…`, currentUrl: info.url });
                if (link.href) { tried.push(link.href); await chrome.tabs.update(tab.id, { url: link.href }); }
                else { tried.push(`text:${link.text}`); await pageSettled(tab.id); }
                empty = 0;
                continue;
            }
        }

        let added = 0, notAdded = 0;
        if (addOffersToCard !== false) {
            await report({ status: "adding", statusLabel: `Adding offers to ${card.displayName}…` });
            await pageStatus(tab.id, { kind: "busy", title: `Adding offers to your ${card.displayName}…` });
            const result = await addOffers(tab.id);
            added = result.added;
            notAdded = result.remaining;
            if (added) {
                await pageSettled(tab.id);
                offers = mergeOffers(offers, await readOffers(tab.id), added);
            }
        }
        let resp;
        try {
            resp = await upload(card, offers);
        } catch (err) {
            const message = err?.message || "Couldn't save offers";
            await report({ status: "error", lastError: message });
            await pageStatus(tab.id, { kind: "error", title: "Couldn't save offers", text: message, actions: [["close", "Close"]] });
            return { ok: false, error: message };
        }
        await learnPage(card, "offers", info.url).catch(() => {});
        // Then the offers already on the card, when the site lists them apart (we chose this tab).
        let already = 0;
        if (!(tabId && !navigate)) {
            already = await saveAddedList(tab, card, { onHome, account, known: new Set(offers.map(offerKey)), report, stopped: () => (job ? job.stopped() : false) });
        }
        const found = offers.length + already;
        const onCard = offers.filter((o) => o.activated).length + already;
        const label = `${added ? `Added ${added} to your card · ` : ""}${found} offers saved${onCard ? ` · ${onCard} on the card` : ""}${notAdded ? ` · ${notAdded} couldn't be added` : ""}`;
        await report({ status: "synced", statusLabel: label, lastScrape: { offers: found, added, at: Date.now() } });
        await pageStatus(tab.id, { kind: "ok", title: `${card.displayName} offers synced`, text: label, autoHide: 7000 });
        notify("Finstracker", `${card.displayName}: ${label}`);
        return { ok: true, kind: "offers", found, added, notAdded, onCard, received: (resp?.received || offers.length) + already, created: resp?.created || 0, updated: resp?.updated || 0 };
    }
    const message = "No offers found on that page. Open your offers list and try again.";
    await report({ status: "error", lastError: message });
    await pageStatus(tab.id, { kind: "error", title: "No offers found", text: message, actions: [["close", "Close"]] });
    return { ok: false, error: message };
}

/** Offers on a tab the user already has open (Read this tab on an offers page). */
export const readOffersFromTab = (card, tabId) => syncOffersForCard(card, { tabId });
