// Points sync for one card.
//
//   1. Use a tab that is already on the card's site (or the tab the user asked for); otherwise open
//      the page saved for the card, or the sign-in page of the site that holds its points.
//   2. Show a status note on the page and keep waiting while the user signs in.
//   3. Read the page. No balance → open the card's rewards page, then follow the site's own
//      rewards links (up to three steps, same site).
//   4. A number found by guessing is highlighted and the user confirms it ("Is this your balance?").
//      Once confirmed (or picked by hand), that spot is trusted and later syncs post straight away.
//   5. Post the difference to Finstracker and remember the page.
import { Tracker } from "../api.js";
import { balanceChange, parseNumber } from "../parse.js";
import { loadPortals, nextHop, originPattern, pageToRemember, resolvePortal, urlMatches } from "../portals.js";
import { balanceHints } from "../programs.js";
import { getState, setState } from "../storage.js";
import { dropCards, session } from "./account.js";
import { clearHighlight, findRewardsLink, highlightBalance, injectPicker, notify, pageSettled, pageStatus, removePicker, showsSignIn, watchBalance } from "./tabs.js";

const CAPTURE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_WAITS = 3; // reads per page (waiting for sign-in does not count)
const WATCH_MS = 15000; // how long one read waits for the page to settle
const SIGN_IN_POLL_MS = 2500;
const TRUSTED = new Set(["user-picker", "user-confirmed"]);
const watching = new Map(); // tabId → { url, token }; a newer navigation supersedes an older watch
let tokens = 0;

export const forgetTab = (tabId) => watching.delete(tabId);
const fmt = (n) => Number(n).toLocaleString();
const siteName = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global|connect)\./, ""); } catch { return "the site"; } };

async function currentSession() {
    return (await getState(["captureSession"])).captureSession;
}
async function patchSession(patch) {
    const s = await currentSession();
    if (s) await setState({ captureSession: { ...s, ...patch } });
}

async function portalFor(card) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    return { portal: resolvePortal(card, portalOverrides, await loadPortals(), rewardsPages), override: portalOverrides?.[card.id] || null };
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

/** Trust a spot the user confirmed, so later syncs read it without asking. Never replaces a picked spot. */
async function trustSelector(cardId, url, selector, source = "user-confirmed") {
    if (!selector) return;
    const { portalOverrides } = await getState(["portalOverrides"]);
    if (source !== "user-picker" && portalOverrides?.[cardId]?.source === "user-picker") return;
    await setState({
        portalOverrides: { ...(portalOverrides || {}), [cardId]: { matchUrl: originPattern(url), capturedUrl: pageToRemember(url), selector, regex: null, source, learnedAt: Date.now() } },
    });
}

/** An open tab on the card's site: the active one first, then the most recently used. */
async function findOpenTab(portal) {
    if (!portal?.matchUrl) return null;
    const onSite = (t) => t?.id && /^https?:/.test(t.url || "") && urlMatches(portal.matchUrl, t.url);
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (onSite(active)) return active;
    const tabs = (await chrome.tabs.query({})).filter(onSite).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0] || null;
}

/** Start a points sync. tabId: read that tab (Read this tab, the on-page prompt); otherwise reuse or open one. */
export async function startCapture({ card, mode = "auto", tabId = null }) {
    const { portal, override } = await portalFor(card);
    let tab = tabId ? await chrome.tabs.get(tabId) : await findOpenTab(portal);
    const reused = Boolean(tab);
    if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* panel window */ }
    } else {
        const url = portal && (portal.loginUrl || portal.pointsUrlHint || portal.capturedUrl);
        if (!url) return { ok: false, error: `No site is known for ${card.displayName}. Open its rewards page, then choose Use this tab or Read this tab.` };
        tab = await chrome.tabs.create({ url, active: true });
    }
    const captureSession = {
        kind: "points",
        cardId: card.id,
        cardName: card.displayName,
        issuer: card.issuer,
        unit: card.rewardType || null,
        tabId: tab.id,
        matchUrl: [...[].concat(portal?.matchUrl || []), tabId ? originPattern(tab.url) : null].filter(Boolean),
        selector: portal?.selector || null,
        regex: portal?.regex || null,
        trustedSelector: TRUSTED.has(override?.source) ? override.selector : null,
        pointsUrlHint: portal?.pointsUrlHint || null,
        hints: portal?.hints || balanceHints(card),
        hops: 0,
        tried: [],
        mode, // "auto" reads the page; "configure" waits for the picker
        startedAt: Date.now(),
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
        status: "opening",
        statusLabel: reused ? `Reading ${siteName(tab.url)}…` : `Opening ${siteName(tab.pendingUrl || tab.url)}…`,
        currentUrl: tab.url || tab.pendingUrl || null,
    };
    await setState({ captureSession });
    if (reused && tab.status === "complete") processTab(tab.id, tab.url, { force: true });
    return { ok: true, reused, session: captureSession };
}

export async function cancelCapture() {
    const s = await currentSession();
    await setState({ captureSession: null });
    if (s?.tabId) { clearHighlight(s.tabId); pageStatus(s.tabId, null); removePicker(s.tabId); }
    return { ok: true };
}

/** The capture tab closed: end the sync. */
export async function onTabClosed(tabId) {
    watching.delete(tabId);
    const s = await currentSession();
    if (s?.tabId === tabId && !["synced", "configured"].includes(s.status)) await setState({ captureSession: null });
}

const statusNote = {
    signIn: (s, url) => ({ kind: "busy", title: `Sign in to ${siteName(url)}`, text: s.mode === "configure" ? `Then click your ${s.cardName} balance.` : `Finstracker will find your ${s.cardName} balance once you're in.`, actions: s.mode === "configure" ? [["close", "Cancel"]] : [["pick", "Pick the balance"], ["close", "Cancel"]] }),
    looking: (s) => ({ kind: "busy", title: `Looking for your ${s.cardName} balance…` }),
    moving: (label) => ({ kind: "busy", title: label }),
    confirm: (s, value) => ({ kind: "ask", title: `Is this your ${s.cardName} balance?`, value: fmt(value), actions: [["confirm", `Use ${fmt(value)}`, true], ["pick", "Pick another"]] }),
    notFound: (s) => ({ kind: "error", title: `Couldn't find your ${s.cardName} balance`, text: "Choose Pick the balance, then click the number on the page.", actions: [["pick", "Pick the balance", true], ["retry", "Try again"]] }),
    synced: (s, result, value) => ({ kind: "ok", title: result.noop ? `${s.cardName} is up to date` : `${s.cardName} synced`, value: fmt(value), autoHide: 6000 }),
    failed: (s, error) => ({ kind: "error", title: `Couldn't sync ${s.cardName}`, text: error, actions: [["retry", "Try again", true], ["close", "Close"]] }),
};

/** One step closer to the balance: the card's points page, or a rewards link on this page. */
async function hop(tabId, url, s) {
    const step = nextHop(s, url);
    if (!step) return false;
    if (step !== "links") {
        await patchSession({ hops: (s.hops || 0) + 1, tried: [...(s.tried || []), step], status: "navigating", statusLabel: "Opening the rewards page…" });
        await pageStatus(tabId, statusNote.moving("Opening the rewards page…"));
        await chrome.tabs.update(tabId, { url: step });
        return true;
    }
    await pageSettled(tabId);
    const found = await findRewardsLink(tabId, s.hints?.keywords || [], s.tried || []);
    if (!found) return false;
    await patchSession({ hops: (s.hops || 0) + 1, tried: [...(s.tried || []), found.href || url], status: "navigating", statusLabel: "Following the rewards link…" });
    await pageStatus(tabId, statusNote.moving("Following the rewards link…"));
    if (found.href) await chrome.tabs.update(tabId, { url: found.href });
    else setTimeout(() => processTab(tabId, url, { force: true }), 2500); // a tab or menu on the same page
    return true;
}

async function finishSync(tabId, s, { value, text, selector, url }, { trust = false } = {}) {
    const result = await syncCardBalance({ id: s.cardId, issuer: s.issuer, displayName: s.cardName }, value);
    if (result.ok) {
        await rememberPage(s.cardId, url).catch(() => {});
        if (trust) await trustSelector(s.cardId, url, selector).catch(() => {});
    }
    await patchSession({
        status: result.ok ? "synced" : "error",
        pending: null,
        lastScrape: { value, text, selector, at: Date.now() },
        lastError: result.ok ? null : result.error,
        currentUrl: url,
    });
    await clearHighlight(tabId);
    await pageStatus(tabId, result.ok ? statusNote.synced(s, result, value) : statusNote.failed(s, result.error));
    if (result.ok) notify("Finstracker", result.noop ? `${s.cardName} is already up to date (${fmt(value)})` : `${s.cardName} synced to ${fmt(value)}`);
    return result;
}

/** Read the capture tab: called when it finishes loading, on in-page route changes, and on Try again. */
export async function processTab(tabId, url, { force = false } = {}) {
    let s = await currentSession();
    if (!s || s.kind === "offers" || s.tabId !== tabId) return;
    if (Date.now() > s.expiresAt) { await setState({ captureSession: null }); return; }
    const picking = s.mode === "configure";
    if (!force && ["synced", "configured"].includes(s.status)) return;
    if (!force && s.status === "confirm" && s.pending && pageToRemember(s.pending.url) === pageToRemember(url)) return;
    if (s.status === "confirm") { await patchSession({ pending: null }); await clearHighlight(tabId); } // moved on: read the new page
    if (!force && s.status === "picking" && !picking) return;
    if (!urlMatches(s.matchUrl, url)) {
        await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(url)}`, currentUrl: url });
        await pageStatus(tabId, statusNote.signIn(s, url)); // shows when we may access the sign-in site
        return;
    }
    if (!force && picking && s.status === "picking" && s.currentUrl === url) return; // picker already open here
    const current = watching.get(tabId);
    if (!force && current && current.url === url) return;
    const token = ++tokens;
    watching.set(tabId, { url, token });
    const superseded = () => watching.get(tabId)?.token !== token;
    const done = () => { if (!superseded()) watching.delete(tabId); };

    let reading = null;
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < MAX_WAITS; attempt++) {
        if (await showsSignIn(tabId)) {
            // Sign-in or verification form: say so right away, then check again shortly.
            if (superseded()) return;
            await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(url)}`, lastError: null, currentUrl: url });
            await pageStatus(tabId, statusNote.signIn(s, url));
            await pause(SIGN_IN_POLL_MS);
            if (superseded()) return;
            if (Date.now() > s.expiresAt) break;
            attempt--; // waiting for the user does not use up attempts
            continue;
        }
        if (picking) {
            // Signed in: hand over to the picker once the page has drawn (it reopens on each page).
            await pageStatus(tabId, statusNote.moving("Getting the picker ready…"));
            await pageSettled(tabId);
            if (superseded()) return;
            done();
            await showPicker(tabId, s);
            return;
        }
        await patchSession({ status: "watching", statusLabel: `Looking for the ${s.cardName} balance…`, currentUrl: url });
        await pageStatus(tabId, statusNote.looking(s));
        try {
            reading = await watchBalance(tabId, s.selector, s.regex, s.unit, WATCH_MS, s.hints);
        } catch (err) {
            done();
            if (/cannot access|permission|not allowed/i.test(err?.message || "")) {
                await patchSession({ status: "error", lastError: `Finstracker can't read ${siteName(url)}. Use Read this tab there to allow it.` });
            }
            return; // otherwise the page navigated away; its next load picks up from here
        }
        if (superseded()) return;
        if (reading && !reading.__awaitingLogin) break;
        reading = null;
        if (!(await showsSignIn(tabId))) break; // signed in, but no balance here
    }
    if (superseded()) return;
    done();
    s = await currentSession();
    if (!s || s.tabId !== tabId) return;

    if (!reading) {
        if (await hop(tabId, url, s)) return;
        await patchSession({ status: "error", lastError: "Couldn't find the balance on this page. Pick the balance, then click the number.", currentUrl: url });
        await pageStatus(tabId, statusNote.notFound(s));
        return;
    }
    const value = parseNumber(reading.text);
    if (value == null) {
        await patchSession({ status: "error", lastError: `Found “${reading.text}” but no number`, currentUrl: url });
        await pageStatus(tabId, statusNote.notFound(s));
        return;
    }
    const trusted = reading.via !== "heuristic" && s.trustedSelector && reading.selector === s.trustedSelector;
    if (trusted) {
        await finishSync(tabId, s, { value, text: reading.text, selector: reading.selector, url });
        return;
    }
    // A guess (or a stock selector): show it and ask before posting anything.
    await patchSession({ status: "confirm", statusLabel: `Is this your ${s.cardName} balance?`, pending: { value, text: reading.text, selector: reading.selector, url, frameId: reading.frameId || 0 }, currentUrl: url });
    await highlightBalance(tabId, reading.frameId, reading.selector);
    await pageStatus(tabId, statusNote.confirm(s, value));
}

/** The user said the highlighted number is right. */
export async function confirmReading() {
    const s = await currentSession();
    if (!s?.pending) return { ok: false, error: "Nothing to confirm" };
    const result = await finishSync(s.tabId, s, s.pending, { trust: true });
    return result.ok ? { ok: true, ...result } : result;
}

/** Look again from the current page (after the user navigated or closed a dialog). */
export async function retryCapture() {
    const s = await currentSession();
    if (!s?.tabId) return { ok: false, error: "No sync in progress" };
    const tab = await chrome.tabs.get(s.tabId);
    await patchSession({ status: "watching", mode: "auto", hops: 0, tried: [], pending: null, lastError: null });
    await clearHighlight(s.tabId);
    processTab(s.tabId, tab.url, { force: true });
    return { ok: true };
}

/** Buttons on the page's status note. */
export async function onStatusAction(action) {
    if (action === "confirm") return confirmReading();
    if (action === "pick") return openPickerOnCaptureTab();
    if (action === "retry") return retryCapture();
    if (action === "close") return cancelCapture();
    return { ok: false, error: "Unknown action" };
}

const pickerPayload = (s) => ({ cardName: s.cardName, unit: s.unit || "points", hints: s.hints || null, canNavigate: true });

async function showPicker(tabId, s) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    await patchSession({ status: "picking", mode: "configure", pending: null, statusLabel: `Click your ${s.cardName} balance on the page`, currentUrl: tab?.url || s.currentUrl });
    await clearHighlight(tabId);
    await pageStatus(tabId, null);
    await injectPicker(tabId, pickerPayload(s));
}

/** Show the picker on the capture tab (Pick another, Pick the balance in the status note). */
export async function openPickerOnCaptureTab() {
    const s = await currentSession();
    if (!s?.tabId) return { ok: false, error: "No sync in progress" };
    await chrome.tabs.update(s.tabId, { active: true });
    await showPicker(s.tabId, { ...s, mode: "configure" });
    return { ok: true };
}

/**
 * "Pick the balance" from the panel or the on-page prompt. On a page of the card's site (or any
 * page when no site is known), pick right there. Otherwise go to the card's site first; the picker
 * opens by itself once the user has signed in.
 */
export async function pickBalance(card, tabId) {
    const { portal } = await portalFor(card);
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const here = tab && /^https?:/.test(tab.url || "") && (!portal || urlMatches(portal.matchUrl, tab.url));
    if (!here) {
        if (!portal) return { ok: false, error: `Open the page that shows your ${card.displayName} balance, then choose Pick the balance.` };
        return startCapture({ card, mode: "configure" });
    }
    const s = {
        kind: "points",
        cardId: card.id,
        cardName: card.displayName,
        issuer: card.issuer,
        unit: card.rewardType || null,
        tabId: tab.id,
        matchUrl: [originPattern(tab.url), ...[].concat(portal?.matchUrl || [])].filter(Boolean),
        selector: portal?.selector || null,
        regex: portal?.regex || null,
        pointsUrlHint: portal?.pointsUrlHint || null,
        hints: portal?.hints || balanceHints(card),
        hops: 0,
        tried: [],
        mode: "configure",
        startedAt: Date.now(),
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
        status: "picking",
        statusLabel: `Click your ${card.displayName} balance on the page`,
        currentUrl: tab.url,
    };
    await setState({ captureSession: s });
    await chrome.tabs.update(tab.id, { active: true });
    await injectPicker(tab.id, pickerPayload(s));
    return { ok: true, here: true };
}
export const openPickerOnTab = pickBalance;

/** "Not on this page" in the picker: go to the rewards page (or follow a rewards link), then pick again. */
export async function pickerNavigate() {
    const s = await currentSession();
    if (!s?.tabId) return { ok: false, error: "No sync in progress" };
    const tab = await chrome.tabs.get(s.tabId);
    if (await hop(s.tabId, tab.url, s)) return { ok: true };
    await pageStatus(s.tabId, { kind: "ask", title: `Open the page with your ${s.cardName} balance`, text: "The picker opens again on each page you visit.", actions: [["pick", "Pick on this page", true], ["close", "Cancel"]] });
    return { ok: true, manual: true };
}

/** The user clicked the balance in the picker: save that page and spot, then sync the value. */
export async function applyPickerResult({ selector, regex, text }) {
    const s = await currentSession();
    if (!s) return { ok: false, error: "No sync in progress" };
    const tab = await chrome.tabs.get(s.tabId);
    await removePicker(s.tabId);
    await trustSelector(s.cardId, tab.url, selector, "user-picker");
    await rememberPage(s.cardId, tab.url, "user");
    await patchSession({ selector, trustedSelector: selector, regex: regex || null, mode: "auto", status: "configured", statusLabel: "Balance spot saved" });
    const value = parseNumber(text);
    if (value == null) {
        await pageStatus(s.tabId, { kind: "error", title: "That spot has no number", text: "Pick the number itself.", actions: [["pick", "Pick again", true], ["close", "Close"]] });
        return { ok: false, error: "No number in the picked spot" };
    }
    const sync = await finishSync(s.tabId, s, { value, text, selector, url: tab.url });
    return { ok: sync.ok, sync };
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
