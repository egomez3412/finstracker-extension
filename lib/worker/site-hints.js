// What the extension shows for the page you are on: a sync prompt on issuer portals, the best
// card's earn rate on the toolbar icon for shops, and (if allowed) a best-card note at checkout.
import { Tracker } from "../api.js";
import { rankCards, badgeText, rateLabel } from "../best-card.js";
import { localToday, openOffers } from "../benefits.js";
import { CATEGORY_LABELS, offerMatchesSite, shoppingContext } from "../merchants.js";
import { cardsForUrl, issuerForUrl, loadPortals } from "../portals.js";
import { getState } from "../storage.js";
import { cards as loadCards, session } from "./account.js";
import { detectCardOn, injectWidget, pageSettled, setBadge, showsSignIn } from "./tabs.js";
import { distinctWords } from "../programs.js";
import { runAutopilot } from "./autopilot.js";
import { rememberPage } from "./capture.js";
import { forgetSiteCards, newCardsView, scanSiteCards, seenSiteCards } from "./new-cards.js";

const DISMISS_MS = 30 * 60 * 1000;
const dismissed = new Map(); // origin → time the user closed a prompt or note there
const shown = new Map(); // tabId → "kind|origin" already injected
let offersCache = { at: 0, list: [] };

export function dismissOrigin(origin) {
    if (origin) dismissed.set(origin, Date.now());
}
export const forgetTabHints = (tabId) => { shown.delete(tabId); prompts.delete(tabId); forgetSiteCards(tabId); };
const prompts = new Map(); // tabId → the payload of the popup on that tab

/** Show the popup with this payload (or update the open one). */
async function showPrompt(tabId, payload) {
    prompts.set(tabId, payload);
    await injectWidget(tabId, { css: "content/prompt.css", js: "content/prompt.js", payloadKey: "__finsPromptPayload", payload });
}
/** Change part of the open popup; never reopens one the user closed. */
async function updatePrompt(tabId, patch) {
    const payload = prompts.get(tabId);
    if (!payload) return;
    prompts.set(tabId, { ...payload, ...patch });
    await injectWidget(tabId, { js: "content/prompt.js", payloadKey: "__finsPromptPayload", payload: { ...patch, update: true } }).catch(() => {});
}

/** Once signed in: cards the site lists that aren't in Finstracker go into the popup to add. */
async function offerNewCards(tabId, url, linked) {
    const { fresh, matched } = await scanSiteCards(tabId, url, linked);
    const patch = {};
    if (fresh.length) patch.newCards = newCardsView(fresh);
    if (!linked.length && Object.keys(matched).length) patch.preselect = Object.keys(matched); // "which cards use this site": tick the ones it lists
    if (Object.keys(patch).length) await updatePrompt(tabId, patch);
}
const recentlyDismissed = (origin) => Date.now() - (dismissed.get(origin) || 0) < DISMISS_MS;
const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };
// One prompt per page: a new page load or an in-app route change shows it again.
const pageKey = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search}`; } catch { return url; } };

async function activeOffers() {
    if (Date.now() - offersCache.at < 5 * 60 * 1000) return offersCache.list;
    const { apiBase, token } = await session();
    if (!token) return [];
    try {
        offersCache = { at: Date.now(), list: openOffers(await Tracker.listOffers(apiBase, token), localToday()) };
    } catch {
        offersCache = { at: Date.now(), list: [] };
    }
    return offersCache.list;
}
export const dropOffers = () => { offersCache = { at: 0, list: [] }; };

/** Best card and matching offers for a URL, for the panel's "On this site" block and the checkout note. */
export async function shoppingAdvice(url) {
    const context = shoppingContext(url);
    if (!context) return null;
    const list = await loadCards();
    if (!list.length) return { context, ranked: [], offers: [] };
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    const offers = (await activeOffers()).filter((o) => offerMatchesSite(o, context)).map((o) => ({ ...o, cardName: byId[o.cardId]?.displayName || "" }));
    return { context, label: CATEGORY_LABELS[context.category], ranked: rankCards(list, context.category), offers };
}

// On airline, hotel and shop sites, only account pages count as "where the points are";
// elsewhere on those sites the best-card hints apply instead.
const ACCOUNT_PAGE = /account|profile|loyalty|rewards|wallet|dashboard|member|skymiles|mileageplus|myunited|aadvantage|trueblue|honors|aeroplan|execclub|yourpayments/i;

/** Cards whose points live on this page: any page of a bank's site, account pages of program sites. */
async function cardsOnPage(url) {
    const portals = await loadPortals();
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    const onBankSite = Boolean(issuerForUrl(url, portals));
    let path = "";
    try { const u = new URL(url); path = u.pathname + u.hash; } catch { return []; }
    if (!onBankSite && !ACCOUNT_PAGE.test(path)) return [];
    return cardsForUrl(await loadCards(), url, portalOverrides, portals, rewardsPages);
}

/** For the side panel: the user's cards on this page, and whether it is a bank's site. */
export async function pageCards(url) {
    const cards = await cardsOnPage(url);
    const bank = issuerForUrl(url, await loadPortals());
    return { ok: true, cardIds: cards.map((c) => c.id), bank, site: siteOf(url) };
}

/** For the side panel: new cards seen on this tab (or look for them now: find = true). */
export async function pageNewCards(tabId, url, { find = false } = {}) {
    if (find) await scanSiteCards(tabId, url, await cardsOnPage(url), { open: true }); // the panel's button
    return { ok: true, newCards: newCardsView(seenSiteCards(tabId, url)) };
}

/** The popup's "Find my cards" (no cards in Finstracker yet): look, opening the card switcher. */
export async function findCardsForPrompt(tabId, url) {
    const { fresh } = await scanSiteCards(tabId, url, await cardsOnPage(url), { open: true });
    await updatePrompt(tabId, { newCards: newCardsView(fresh), scanned: true, canFind: false });
    return { ok: true, found: fresh.length };
}

/** After cards were added from the popup, board or panel: show the popup again with them in it. */
export async function afterCardsAdded(tabId, url) {
    shown.delete(tabId);
    if (prompts.has(tabId)) await promptOnPortal(tabId, url);
}
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global|connect)\./, ""); } catch { return ""; } };

/**
 * "These cards use this site": saves the page as each card's rewards page, so the site is linked to
 * them from now on. Then shows the popup for them (or starts autopilot).
 */
export async function linkCardsToSite(tabId, url, cardIds, { run = false } = {}) {
    for (const id of cardIds || []) await rememberPage(id, url, "user");
    shown.delete(tabId);
    if (run) {
        runAutopilot(cardIds, { tabId }).catch((err) => console.warn("[finstracker] autopilot", err));
    } else {
        await promptOnPortal(tabId, url);
    }
    return { ok: true };
}

async function promptOnPortal(tabId, url) {
    const { autoDetect, captureSession } = await getState(["autoDetect", "captureSession"]);
    const candidates = await cardsOnPage(url);
    if (!candidates.length) {
        // A bank's site, but none of the user's cards is linked to it (e.g. a card saved without its
        // issuer): ask which cards use it.
        const bank = issuerForUrl(url, await loadPortals());
        if (!bank || !autoDetect || captureSession || recentlyDismissed(originOf(url))) return false;
        const all = await loadCards();
        // No cards in Finstracker yet (a new account, or after Start over): offer the cards this site
        // lists, to add and run in one go. Looked for again on each page until it finds them (sign-in).
        const key = all.length ? `link|${originOf(url)}` : `start|${pageKey(url)}`;
        if (shown.get(tabId) === key) return true;
        shown.set(tabId, key);
        if (!all.length) {
            try {
                await showPrompt(tabId, { mode: "start", bank, cards: [], allCards: [] });
                // Bank pages draw their cards late: look a few times (reading only; the switcher is
                // opened only by "Find my cards").
                let fresh = [];
                for (let i = 0; i < 5 && !fresh.length && prompts.has(tabId) && shown.get(tabId) === key; i++) {
                    if (i) await new Promise((r) => setTimeout(r, 1500));
                    ({ fresh } = await scanSiteCards(tabId, url, []));
                }
                // Nothing in view: offer "Find my cards" (opens the site's card switcher on that click),
                // or ask to sign in first.
                await updatePrompt(tabId, { newCards: newCardsView(fresh), scanned: true, canFind: !fresh.length && !(await showsSignIn(tabId)) });
            } catch { shown.delete(tabId); }
            return true;
        }
        try {
            await showPrompt(tabId, { mode: "link", bank, cards: [], allCards: all.map(cardPayload) });
            offerNewCards(tabId, url, []).catch(() => {});
        } catch { shown.delete(tabId); }
        return true;
    }
    await setBadge(tabId, candidates.length === 1 ? "•" : String(candidates.length));
    const origin = originOf(url);
    const key = `portal|${pageKey(url)}`;
    if (shown.get(tabId) === key) return true;
    shown.set(tabId, key);
    // The prompt, unless it was closed here recently, sync prompts are off, or a sync is running;
    // then the small quick tab on the page's edge instead.
    if (!autoDetect || captureSession || recentlyDismissed(origin)) {
        await showQuickTab(tabId, url, candidates);
        return true;
    }
    try {
        // Show it right away; once the page has drawn, mark the card it shows.
        const payload = { cards: candidates.map(cardPayload), current: candidates.length === 1 ? candidates[0].id : null };
        await showPrompt(tabId, payload);
        (async () => {
            if (candidates.length > 1) { const current = await currentCard(tabId, candidates); if (current) await updatePrompt(tabId, { current }); }
            await offerNewCards(tabId, url, candidates);
        })().catch(() => {});
    } catch (err) {
        shown.delete(tabId); // restricted page; the badge still shows
        console.warn("[finstracker] prompt skipped", err?.message);
    }
    return true;
}

/** Which of these cards the page shows (the top bar or card switcher), once the page has drawn. */
async function currentCard(tabId, cards) {
    if (!cards || cards.length < 2) return cards?.[0]?.id || null;
    const site = cards.map((c) => ({ id: c.id, words: distinctWords(c, cards.filter((o) => o.id !== c.id)) }));
    await pageSettled(tabId);
    // The top bar often draws after the page loads: look a few times.
    for (let i = 0; i < 6; i++) {
        const seen = await detectCardOn(tabId, site);
        if (seen?.strong) return seen.id;
        await new Promise((r) => setTimeout(r, 700));
    }
    return null;
}

const cardPayload = (c) => ({ id: c.id, displayName: c.displayName, issuer: c.issuer, cardKey: c.cardKey || null, program: c.program || "", rewardType: c.rewardType || null });

/** The draggable Finstracker tab on the page's edge (content/launcher.js), unless turned off or hidden here. */
export async function showQuickTab(tabId, url, cards) {
    const { launcherOn, launcherHidden } = await getState(["launcherOn", "launcherHidden"]);
    if (launcherOn === false || launcherHidden?.[originOf(url)]) return false;
    try {
        const current = await currentCard(tabId, cards || []);
        await injectWidget(tabId, { js: "content/launcher.js", payloadKey: "__finsLauncherPayload", payload: { cards: (cards || []).map(cardPayload), current } });
        return true;
    } catch {
        return false;
    }
}

/** The sync prompt was closed: remember that for this site and leave the quick tab in its place. */
export async function collapsePrompt(tabId, url) {
    dismissOrigin(originOf(url));
    await showQuickTab(tabId, url, await cardsOnPage(url));
    return { ok: true };
}

async function noteAtCheckout(tabId, url, advice) {
    const { checkoutHints } = await getState(["checkoutHints"]);
    const origin = originOf(url);
    if (!checkoutHints || !advice.context.checkout || !advice.ranked.length || recentlyDismissed(origin)) return;
    if (shown.get(tabId) === `checkout|${url}`) return;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return;
    shown.set(tabId, `checkout|${url}`);
    const [best, next] = advice.ranked;
    const pick = (r) => r && { name: r.card.displayName, rate: rateLabel(r.card, r.rate), cents: r.cents };
    try {
        await injectWidget(tabId, {
            css: ["content/prompt.css", "content/checkout.css"],
            js: "content/checkout.js",
            payloadKey: "__finsCheckoutPayload",
            payload: {
                merchant: advice.context.guessed ? "" : advice.context.name,
                category: advice.label,
                best: pick(best),
                next: next && next.cents < best.cents ? pick(next) : null,
                offers: advice.offers.slice(0, 2).map((o) => ({ title: o.title || o.merchant, cardName: o.cardName, expiresAt: o.expiresAt })),
            },
        });
    } catch (err) {
        shown.delete(tabId);
        console.warn("[finstracker] checkout note skipped", err?.message);
    }
}

/** Called for every finished navigation. */
export async function onTabVisited(tabId, url) {
    const { token } = await session();
    if (!token || !/^https?:/.test(url)) { await setBadge(tabId, ""); return; }
    try {
        if (await promptOnPortal(tabId, url)) return;
        const advice = await shoppingAdvice(url);
        if (!advice?.ranked.length) { await setBadge(tabId, ""); return; }
        await setBadge(tabId, badgeText(advice.ranked[0]));
        await noteAtCheckout(tabId, url, advice);
    } catch (err) {
        console.warn("[finstracker] site hints", err?.message);
    }
}
