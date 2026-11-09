// Points sync: open the card's portal, wait for the user to sign in, find the rewards page, read the
// balance and post the difference to Finstracker as an earn or redeem.
//
// Finding the points:
//   1. open the page saved for the card (where the balance was found last time), else the sign-in page
//   2. after sign-in, read the page the site lands on
//   3. no balance there → open the card's points page, then follow the site's own rewards links
//      (up to three hops)
//   4. remember the page and spot that worked for next time
import { Tracker } from "../api.js";
import { balanceChange, parseNumber } from "../parse.js";
import { loadPortals, nextHop, originPattern, pageToRemember, resolvePortal, urlMatches } from "../portals.js";
import { balanceHints } from "../programs.js";
import { getState, setState } from "../storage.js";
import { findRewardsLink } from "../inject/links.js";
import { dropCards, session } from "./account.js";
import { injectPicker, notify, readBalance, showsSignIn, watchBalance } from "./tabs.js";

const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_WAITS = 12; // sign-in checks per page (each up to 25s)
const watching = new Map(); // tabId → { url, token }; a newer navigation supersedes an older watch
let tokens = 0;

export const forgetTab = (tabId) => watching.delete(tabId);

async function patchSession(patch) {
    const { captureSession } = await getState(["captureSession"]);
    if (captureSession) await setState({ captureSession: { ...captureSession, ...patch } });
}

async function portalFor(card) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    return resolvePortal(card, portalOverrides, await loadPortals(), rewardsPages);
}

/** Post the change that makes the card match the portal. */
export async function syncCardBalance(card, scraped) {
    const { apiBase, token } = await session();
    if (!token) return { ok: false, error: "Sign in to Finstracker first" };
    let fresh;
    try {
        fresh = await Tracker.getCard(apiBase, token, card.id);
    } catch (err) {
        return { ok: false, error: err.message || "Card lookup failed" };
    }
    if (!fresh) return { ok: false, error: "Card not found" };
    const change = balanceChange(fresh, scraped);
    if (!change.type) return { ok: true, noop: true, target: change.target, current: change.current };
    try {
        await Tracker.postTransaction(apiBase, token, { cardId: card.id, type: change.type, unit: change.unit, amount: change.amount, note: "Synced with Finstracker Sync" });
    } catch (err) {
        return { ok: false, error: err.message || "Couldn't save the new balance" };
    }
    await dropCards();
    return { ok: true, target: change.target, current: change.current, delta: change.delta, type: change.type };
}

/** Save the page a balance was found on. A page the user set stays until they change it. */
export async function rememberPage(cardId, url, source = "learned") {
    const page = pageToRemember(url);
    if (!page) return;
    const { rewardsPages } = await getState(["rewardsPages"]);
    if (source === "learned" && rewardsPages?.[cardId]?.source === "user") return;
    await setState({ rewardsPages: { ...(rewardsPages || {}), [cardId]: { url: page, source, at: Date.now() } } });
}

/** Remember the selector that worked, so the next sync reads it directly. Never replaces a user pick. */
async function learnSelector(cardId, url, selector) {
    const { portalOverrides } = await getState(["portalOverrides"]);
    if (portalOverrides?.[cardId]?.source === "user-picker") return;
    await setState({
        portalOverrides: { ...(portalOverrides || {}), [cardId]: { matchUrl: originPattern(url), capturedUrl: pageToRemember(url), selector, regex: null, source: "auto-learned", learnedAt: Date.now() } },
    });
}

/** Open the card's portal in a new tab and start watching it. */
export async function startCapture({ card, mode = "auto" }) {
    const portal = await portalFor(card);
    const url = portal && (portal.loginUrl || portal.pointsUrlHint || portal.capturedUrl);
    if (!url) return { ok: false, error: `No sign-in page is known for ${card.displayName}. Open its rewards page, then choose Use this tab.` };

    const tab = await chrome.tabs.create({ url, active: true });
    const captureSession = {
        cardId: card.id,
        cardName: card.displayName,
        issuer: card.issuer,
        unit: card.rewardType || null,
        tabId: tab.id,
        matchUrl: portal.matchUrl,
        selector: portal.selector,
        regex: portal.regex || null,
        pointsUrlHint: portal.pointsUrlHint || null,
        hints: portal.hints,
        hops: 0,
        tried: [],
        mode, // "auto" reads on navigation; "configure" waits for the picker
        startedAt: Date.now(),
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
        status: "opening",
        statusLabel: `Opening ${siteName(url)}…`,
        currentUrl: url,
    };
    await setState({ captureSession });
    return { ok: true, session: captureSession };
}

const siteName = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global)\./, ""); } catch { return "the portal"; } };

export async function cancelCapture() {
    await setState({ captureSession: null });
    return { ok: true };
}

/** Go one step closer to the balance: the card's points page, or a rewards link on this page. */
async function hop(tabId, url, s) {
    const step = nextHop(s, url);
    if (!step) return false;
    if (step !== "links") {
        await patchSession({ hops: (s.hops || 0) + 1, tried: [...(s.tried || []), step], status: "navigating", statusLabel: "Opening the rewards page…" });
        await chrome.tabs.update(tabId, { url: step });
        return true;
    }
    let found = null;
    try {
        const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: findRewardsLink, args: [s.hints?.keywords || [], s.tried || []] });
        found = result?.result || null;
    } catch { /* page closed or navigating */ }
    if (!found) return false;
    await patchSession({ hops: (s.hops || 0) + 1, tried: [...(s.tried || []), found.href || url], status: "navigating", statusLabel: "Following the rewards link…" });
    if (found.href) await chrome.tabs.update(tabId, { url: found.href });
    else setTimeout(() => onCaptureTabNavigated(tabId, url, { afterClick: true }), 2500); // in-page tab or menu
    return true;
}

/** A tab in the capture session navigated: read the balance once the page settles. */
export async function onCaptureTabNavigated(tabId, url, { afterClick = false } = {}) {
    let { captureSession: s } = await getState(["captureSession"]);
    if (!s || s.kind === "offers" || s.tabId !== tabId) return;
    if (Date.now() > s.expiresAt) { await setState({ captureSession: null }); return; }
    if (["synced", "configured", "picking"].includes(s.status)) return;
    if (!urlMatches(s.matchUrl, url)) {
        await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(url)}`, currentUrl: url });
        return;
    }
    if (s.mode === "configure") return;
    const current = watching.get(tabId);
    if (!afterClick && current && current.url === url) return;
    const token = ++tokens;
    watching.set(tabId, { url, token });
    const superseded = () => watching.get(tabId)?.token !== token;

    let reading = null;
    for (let wait = 0; wait < MAX_WAITS; wait++) {
        await patchSession({ status: "watching", statusLabel: `Looking for the ${s.cardName} balance…`, currentUrl: url });
        try {
            reading = await watchBalance(tabId, s.selector, s.regex, s.unit, 25000, s.hints);
        } catch {
            return; // the page navigated away; the next navigation picks it up
        }
        if (superseded()) return;
        if (reading && !reading.__awaitingLogin) break;
        if (reading?.__awaitingLogin || (await showsSignIn(tabId))) {
            reading = null;
            await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(url)}`, lastError: null, currentUrl: url });
            continue; // still signing in on this page: keep checking
        }
        break; // signed in, but no balance here
    }
    if (superseded()) return;
    watching.delete(tabId);
    ({ captureSession: s } = await getState(["captureSession"]));
    if (!s || s.tabId !== tabId) return;

    if (!reading) {
        if (await hop(tabId, url, s)) return;
        await patchSession({ status: "error", lastError: "Couldn't find the balance. Open the rewards page, then choose Pick the balance.", currentUrl: url });
        return;
    }
    const value = parseNumber(reading.text);
    if (value == null) {
        await patchSession({ status: "error", lastError: `Found “${reading.text}” but no number`, currentUrl: url });
        return;
    }

    const card = { id: s.cardId, issuer: s.issuer, displayName: s.cardName };
    const result = await syncCardBalance(card, value);
    if (result.ok) {
        await rememberPage(s.cardId, url).catch(() => {});
        if (reading.via === "heuristic" && reading.selector) await learnSelector(s.cardId, url, reading.selector).catch(() => {});
    }
    await patchSession({
        status: result.ok ? "synced" : "error",
        lastScrape: { value, text: reading.text, selector: reading.selector, at: Date.now() },
        lastError: result.ok ? null : result.error,
        currentUrl: url,
    });
    if (result.ok) notify("Finstracker", result.noop ? `${s.cardName} is already up to date (${value.toLocaleString()})` : `${s.cardName} synced to ${value.toLocaleString()}`);
    else notify("Finstracker: sync failed", result.error);
}

/** Read the balance on a tab the user already has open ("Read this tab"). Works on any site. */
export async function readPointsFromTab(card, tabId, url) {
    const portal = await portalFor(card);
    const known = portal && urlMatches(portal.matchUrl, url);
    const hints = portal?.hints || balanceHints(card);
    const reading = await readBalance(tabId, known ? portal.selector : null, known ? portal.regex : null, card.rewardType, hints);
    if (!reading || reading.__awaitingLogin) return null;
    const value = parseNumber(reading.text);
    if (value == null) return { ok: false, error: `Found “${reading.text}” but no number` };
    const result = await syncCardBalance(card, value);
    if (result.ok) {
        await rememberPage(card.id, url).catch(() => {});
        if (reading.via === "heuristic" && reading.selector) await learnSelector(card.id, url, reading.selector).catch(() => {});
    }
    return { ...result, kind: "points", scraped: { value, text: reading.text, selector: reading.selector } };
}

/** Show the picker on the capture tab (from the panel's status strip). */
export async function openPickerOnCaptureTab() {
    const { captureSession: s } = await getState(["captureSession"]);
    if (!s?.tabId) return { ok: false, error: "No sync in progress" };
    await patchSession({ status: "picking", mode: "configure", statusLabel: `Click the ${s.cardName} balance on the page` });
    await injectPicker(s.tabId);
    await chrome.tabs.update(s.tabId, { active: true });
    return { ok: true };
}

/** Start the picker on a page the user is already on (from the on-page prompt or the panel). */
export async function openPickerOnTab(card, tabId) {
    const tab = await chrome.tabs.get(tabId);
    const portal = await portalFor(card);
    await setState({
        captureSession: {
            cardId: card.id,
            cardName: card.displayName,
            issuer: card.issuer,
            unit: card.rewardType || null,
            tabId,
            matchUrl: [originPattern(tab.url), ...[].concat(portal?.matchUrl || [])].filter(Boolean),
            selector: portal?.selector || null,
            regex: portal?.regex || null,
            hints: portal?.hints || balanceHints(card),
            mode: "configure",
            startedAt: Date.now(),
            expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
            status: "picking",
            statusLabel: `Click the ${card.displayName} balance on the page`,
            currentUrl: tab.url || null,
        },
    });
    await injectPicker(tabId);
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
}

/** The user clicked the balance in the picker: save that page and spot, then sync the value. */
export async function applyPickerResult({ selector, regex, text }) {
    const { captureSession: s, portalOverrides } = await getState(["captureSession", "portalOverrides"]);
    if (!s) return { ok: false, error: "No sync in progress" };
    const tab = await chrome.tabs.get(s.tabId);
    const override = { matchUrl: originPattern(tab.url) || [].concat(s.matchUrl)[0], capturedUrl: pageToRemember(tab.url), selector, regex: regex || null, source: "user-picker" };
    await setState({
        portalOverrides: { ...(portalOverrides || {}), [s.cardId]: override },
        captureSession: { ...s, selector, matchUrl: override.matchUrl, regex: override.regex, mode: "auto", capturedUrl: override.capturedUrl, status: "configured", statusLabel: "Balance spot saved" },
    });
    await rememberPage(s.cardId, tab.url, "user");
    const value = parseNumber(text);
    if (value == null) return { ok: true, override };
    const sync = await syncCardBalance({ id: s.cardId, issuer: s.issuer, displayName: s.cardName }, value);
    if (sync.ok) await patchSession({ status: "synced", lastScrape: { value, text, selector, at: Date.now() }, lastError: null });
    return { ok: true, override, sync };
}

/** "Use this tab": make the open page the card's rewards page. */
export async function setRewardsPage(cardId, url) {
    if (!pageToRemember(url)) return { ok: false, error: "Open the card's rewards page in a normal tab first" };
    await rememberPage(cardId, url, "user");
    return { ok: true, url: pageToRemember(url) };
}

/** Forget the saved page and balance spot for a card. */
export async function clearOverride(cardId) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    const strip = (map) => { const next = { ...(map || {}) }; delete next[cardId]; return next; };
    if (cardId) await setState({ portalOverrides: strip(portalOverrides), rewardsPages: strip(rewardsPages) });
    return { ok: true };
}
