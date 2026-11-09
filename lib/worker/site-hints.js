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
import { maybeRunDaily } from "./autopilot.js";

const DISMISS_MS = 30 * 60 * 1000;
const dismissed = new Map(); // origin → time the user closed a prompt or note there
const shown = new Map(); // tabId → "kind|origin" already injected
let offersCache = { at: 0, list: [] };

export function dismissOrigin(origin) {
    if (origin) dismissed.set(origin, Date.now());
}
export const forgetTabHints = (tabId) => shown.delete(tabId);
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

async function promptOnPortal(tabId, url) {
    const { autoDetect, captureSession } = await getState(["autoDetect", "captureSession"]);
    const candidates = await cardsOnPage(url);
    if (!candidates.length) return false;
    // Signed in on a card's site: run the daily autopilot for these cards if it is due.
    showsSignIn(tabId).then((signingIn) => { if (!signingIn) maybeRunDaily(candidates.map((c) => c.id)); }).catch(() => {});
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
        const current = await currentCard(tabId, candidates);
        await injectWidget(tabId, { css: "content/prompt.css", js: "content/prompt.js", payloadKey: "__finsPromptPayload", payload: { cards: candidates.map(cardPayload), current } });
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
