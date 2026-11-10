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
import { balanceChange, noiseReason, parseNumber } from "../parse.js";
import { isLoginPage, loadPortals, nextHop, originPattern, pageToRemember, resolvePortal, startPage, urlMatches } from "../portals.js";
import { balanceHints } from "../programs.js";
import { getState, setState } from "../storage.js";
import { cards as loadCards, dropCards, session } from "./account.js";
import { clearHighlight, detectCardOn, findRewardsLink, foundNearCardOn, highlightBalance, injectPicker, notify, pageSettled, pageStatus, readBalance, removePicker, showsSignIn, switchAccountOn, watchBalance } from "./tabs.js";
import { siteCardsFor } from "./sites.js";
import { syncPointsHistory } from "./points-history.js";

const CAPTURE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_WAITS = 3; // reads per page (waiting for sign-in does not count)
const WATCH_MS = 15000; // how long one read waits for the page to settle
const SIGN_IN_POLL_MS = 2500;
const TRUSTED = new Set(["user-picker", "user-confirmed"]);
const watching = new Map(); // tabId → { url, token }; a newer navigation supersedes an older watch
let tokens = 0;

export const forgetTab = (tabId) => watching.delete(tabId);
/** 98,765 for points, $123.45 for cash back. */
export const fmtValue = (unit, n) => (unit === "cashback" ? `$${Number(n).toFixed(2)}` : Number(n).toLocaleString());
const unitLabel = (unit) => (unit === "cashback" ? "cash back" : "points");
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
export async function startCapture({ card, mode = "auto", tabId = null, navigate = false, background = false, switchTo = null }) {
    const { portal, override } = await portalFor(card);
    const { rewardsPages } = await getState(["rewardsPages"]);
    // Never the sign-in page when there's another: loading Amex's login page signs you out.
    const url = portal && startPage(portal, rewardsPages?.[card.id]?.url);
    const siteCards = await siteCardsFor(card); // the user's cards on this site, to check which one the page shows
    let tab = tabId ? await chrome.tabs.get(tabId) : background ? null : await findOpenTab(portal);
    // Autopilot: take the work tab to this card's page; never from a signed-in page on the site to its
    // sign-in page (that would end the session the user has).
    const onSite = tab && portal?.matchUrl && urlMatches(portal.matchUrl, tab.url || "");
    const goTo = tab && navigate && url && !(onSite && isLoginPage(url)) ? url : null;
    if (!tab && !url) return { ok: false, error: `No site is known for ${card.displayName}. Open its rewards page, then choose Use this tab or Read this tab.` };
    const reused = Boolean(tab) && !goTo;
    const session = (t) => ({
        kind: "points",
        cardId: card.id,
        cardName: card.displayName,
        issuer: card.issuer,
        program: card.program || "",
        unit: card.rewardType || null,
        tabId: t.id,
        matchUrl: [...[].concat(portal?.matchUrl || []), tabId ? originPattern(t.url) : null].filter(Boolean),
        selector: portal?.selector || null,
        regex: portal?.regex || null,
        trustedSelector: TRUSTED.has(override?.source) ? override.selector : null,
        pointsUrlHint: portal?.pointsUrlHint || null,
        hints: portal?.hints || balanceHints(card),
        hops: 0,
        tried: [],
        mode, // "auto" reads the page; "configure" waits for the picker
        background, // autopilot in a background tab: never wait for sign-in
        switchTo, // { words, others, cards }: select this card in the site's card switcher before reading
        siteCards,
        startedAt: Date.now(),
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
        status: "opening",
        statusLabel: reused ? `Reading ${siteName(t.url)}…` : `Opening ${siteName(goTo || url || t.url)}…`,
        currentUrl: goTo || t.url || t.pendingUrl || url || null,
    });
    // Save the session before any navigation, so the page's first load is read for this card.
    let captureSession;
    if (tab) {
        captureSession = session(tab);
        await setState({ captureSession });
        if (goTo) tab = await chrome.tabs.update(tab.id, { url: goTo, ...(background ? {} : { active: true }) });
        else if (!background) {
            await chrome.tabs.update(tab.id, { active: true });
            try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* panel window */ }
        }
    } else {
        tab = await chrome.tabs.create({ url: "about:blank", active: !background });
        captureSession = session(tab);
        await setState({ captureSession });
        tab = await chrome.tabs.update(tab.id, { url });
    }
    // A page that was already loaded (or loaded very fast) gets read now.
    const now = await chrome.tabs.get(tab.id).catch(() => null);
    if (now?.status === "complete" && /^https?:/.test(now.url || "") && (reused || !goTo || pageToRemember(now.url) === pageToRemember(goTo))) processTab(now.id, now.url, { force: reused });
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
    confirm: (s, value) => ({ kind: "ask", title: `Is this your ${s.cardName} balance?`, value: fmtValue(s.unit, value), actions: [["confirm", `Use ${fmtValue(s.unit, value)}`, true], ["pick", "Pick another"]] }),
    mismatch: (s, alt) => ({ kind: "ask", title: `This page shows ${unitLabel(alt.unit)}`, value: fmtValue(alt.unit, alt.value), text: `Finstracker tracks ${s.cardName} in ${unitLabel(s.unit)}. Switch the card to ${unitLabel(alt.unit)}?`, actions: [["switch-type", `Switch to ${unitLabel(alt.unit)}`, true], ["pick", "Pick the balance"]] }),
    notFound: (s) => ({ kind: "error", title: `Couldn't find your ${s.cardName} balance`, text: "Choose Pick the balance, then click the number on the page.", actions: [["pick", "Pick the balance", true], ["retry", "Try again"]] }),
    synced: (s, result, value) => ({ kind: "ok", title: result.noop ? `${s.cardName} is up to date` : `${s.cardName} synced`, value: fmtValue(s.unit, value), text: result.activity ? `${result.activity} new points activity ${result.activity === 1 ? "line" : "lines"} saved` : "", autoHide: 6000 }),
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
        await setState({ lastPull: { ...((await getState(["lastPull"])).lastPull || {}), [s.cardId]: Date.now() } });
        // Then the points history: only lines Finstracker doesn't have yet (this page, or the
        // issuer's activity page in this tab), each to the card in its card column.
        await patchSession({ status: "history", statusLabel: `Balance saved · reading ${s.cardName} points activity…` });
        const history = await syncPointsHistory(tabId, { id: s.cardId, issuer: s.issuer, displayName: s.cardName, program: s.program || "" }, { cards: s.siteCards || [] }).catch((err) => { console.warn("[finstracker] history", err?.message); return { added: 0 }; });
        result.activity = history.added || 0;
    }
    await patchSession({
        status: result.ok ? "synced" : "error",
        statusLabel: result.ok ? `${result.noop ? "Up to date" : "Synced"} · ${fmtValue(s.unit, value)}${result.activity ? ` · ${result.activity} new activity ${result.activity === 1 ? "line" : "lines"}` : ""}` : null,
        pending: null,
        lastScrape: { value, text, selector, at: Date.now() },
        lastError: result.ok ? null : result.error,
        currentUrl: url,
    });
    await clearHighlight(tabId);
    await pageStatus(tabId, result.ok ? statusNote.synced(s, result, value) : statusNote.failed(s, result.error));
    if (result.ok) notify("Finstracker", result.noop ? `${s.cardName} is already up to date (${fmtValue(s.unit, value)})` : `${s.cardName} synced to ${fmtValue(s.unit, value)}`);
    return result;
}

/**
 * Several of the user's cards share this site: make sure the page shows the card being synced (the
 * name in the top bar or card switcher). A manual sync follows the card on screen and says so;
 * autopilot selects its card once more and otherwise skips it. Returns the (possibly updated)
 * session, or null when this card must not be read here.
 */
async function checkShownCard(tabId, s, url) {
    let seen = await detectCardOn(tabId, s.siteCards);
    if (!seen?.strong || seen.id === s.cardId) {
        const verified = Boolean(seen?.strong);
        if (verified !== s.verified) await patchSession({ verified });
        return { ...s, verified };
    }
    if (s.switchTo) {
        if (!s.reselected) {
            await patchSession({ reselected: true });
            const again = await switchAccountOn(tabId, s.switchTo.words, s.switchTo.others);
            if (again.clicked) await pageSettled(tabId);
            seen = await detectCardOn(tabId, s.siteCards);
            if (!seen?.strong || seen.id === s.cardId) { await patchSession({ verified: Boolean(seen?.strong) }); return { ...s, reselected: true, verified: Boolean(seen?.strong) }; }
        }
        // Still another card on top: read anyway, but only accept a number next to this card's own name
        // (pages that list several cards). Checked after reading.
        const shownOther = s.siteCards.find((c) => c.id === seen.id)?.name || "another card";
        await patchSession({ shownOther, verified: false });
        return { ...s, shownOther, verified: false };
    }
    // Manual sync: sync the card the page shows.
    const target = (await loadCards()).find((c) => c.id === seen.id);
    if (!target) return { ...s, verified: false };
    const { portal, override } = await portalFor(target);
    const next = {
        cardId: target.id,
        cardName: target.displayName,
        issuer: target.issuer,
        unit: target.rewardType || null,
        selector: portal?.selector || null,
        regex: portal?.regex || null,
        trustedSelector: TRUSTED.has(override?.source) ? override.selector : null,
        pointsUrlHint: portal?.pointsUrlHint || s.pointsUrlHint,
        hints: portal?.hints || balanceHints(target),
        verified: true,
        followedFrom: s.cardName,
    };
    await patchSession(next);
    await pageStatus(tabId, statusNote.moving(`This page shows ${target.displayName}, so Finstracker is syncing it`));
    return { ...s, ...next };
}

/** Read the capture tab: called when it finishes loading, on in-page route changes, and on Try again. */
export async function processTab(tabId, url, { force = false } = {}) {
    if (!/^https?:/.test(url || "")) return; // about:blank while a tab is being opened
    let s = await currentSession();
    if (!s || s.kind === "offers" || s.tabId !== tabId) return;
    if (Date.now() > s.expiresAt) { await setState({ captureSession: null }); return; }
    const picking = s.mode === "configure";
    if (!force && ["synced", "configured", "history"].includes(s.status)) return; // done (or reading history)
    if (!force && s.status === "mismatch" && s.mismatch && pageToRemember(s.mismatch.url) === pageToRemember(url)) return;
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
            if (s.background) {
                done();
                await patchSession({ status: "error", lastError: `Sign in to ${siteName(url)} first`, needsSignIn: true, currentUrl: url });
                return;
            }
            await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(url)}`, lastError: null, currentUrl: url });
            await pageStatus(tabId, statusNote.signIn(s, url));
            await pause(SIGN_IN_POLL_MS);
            if (superseded()) return;
            if (Date.now() > s.expiresAt) break;
            attempt--; // waiting for the user does not use up attempts
            continue;
        }
        if (s.switchTo && !s.switchResult) {
            // Several cards on this site: select this one in the site's card switcher first.
            await pageStatus(tabId, statusNote.moving(`Selecting ${s.cardName}…`));
            await pageSettled(tabId);
            const switched = await switchAccountOn(tabId, s.switchTo.words, s.switchTo.others);
            s = { ...s, switchResult: switched };
            await patchSession({ switchResult: switched });
            if (switched.clicked) await pageSettled(tabId);
            if (superseded()) return;
        }
        if (s.siteCards?.length > 1 && !picking) {
            const checked = await checkShownCard(tabId, s, url);
            if (superseded()) return;
            if (!checked) { done(); return; }
            s = checked;
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
        // Nothing in this card's unit: does the page clearly show the other kind (cash back vs points)?
        const other = s.unit === "cashback" ? "points" : "cashback";
        const alt = await readBalance(tabId, null, null, other, balanceHints({ displayName: s.cardName, issuer: s.issuer, rewardType: other })).catch(() => null);
        const altValue = alt && !alt.__awaitingLogin ? parseNumber(alt.text) : null;
        if (altValue != null && (alt.score || 0) >= 15) {
            const mismatch = { unit: other, value: altValue, text: alt.text, selector: alt.selector, url, frameId: alt.frameId || 0 };
            await patchSession({ status: "mismatch", statusLabel: `This page shows ${unitLabel(other)}`, mismatch, currentUrl: url });
            await highlightBalance(tabId, alt.frameId, alt.selector);
            await pageStatus(tabId, statusNote.mismatch(s, mismatch));
            return;
        }
        await patchSession({ status: "error", lastError: "Couldn't find the balance on this page. Pick the balance, then click the number.", currentUrl: url });
        await pageStatus(tabId, statusNote.notFound(s));
        return;
    }
    const value = parseNumber(reading.text);
    const noise = value == null ? null : noiseReason(reading.text, value);
    if (value == null || noise) {
        // Never save a year, date, phone number or copyright line as a balance.
        await patchSession({ status: "error", lastError: noise ? `Found ${noise} (“${reading.text}”), not a balance. Pick the balance on the page.` : `Found “${reading.text}” but no number`, currentUrl: url });
        await pageStatus(tabId, statusNote.notFound(s));
        return;
    }
    if (s.shownOther) {
        // The site shows another card on top: this number counts only if it sits by this card's name.
        const mine = s.siteCards?.find((c) => c.id === s.cardId)?.words || [];
        if (!(await foundNearCardOn(tabId, reading.frameId, mine))) {
            const message = `This page shows ${s.shownOther}, not ${s.cardName}, so ${s.cardName} was skipped.`;
            await patchSession({ status: "error", lastError: message, wrongCard: true, currentUrl: url });
            await pageStatus(tabId, { kind: "error", title: `Couldn't select ${s.cardName}`, text: message, autoHide: 6000 });
            return;
        }
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

/**
 * "Switch to cash back" (or points): the page shows the other kind of balance. Finstracker only
 * changes a card's type while it has no activity; otherwise the user changes it on the card.
 */
export async function switchCardType() {
    const s = await currentSession();
    if (!s?.mismatch) return { ok: false, error: "Nothing to switch" };
    const { apiBase, token } = await session();
    try {
        await Tracker.updateCard(apiBase, token, s.cardId, { rewardType: s.mismatch.unit });
    } catch (err) {
        const text = /transactions/i.test(err.message || "") ? `${s.cardName} already has activity in Finstracker, so its type can't change here. Change it on the card in Finstracker.` : err.message || "Couldn't change the card";
        await pageStatus(s.tabId, { kind: "error", title: "Couldn't switch the card", text, actions: [["close", "Close"]] });
        await patchSession({ status: "error", lastError: text });
        return { ok: false, error: text };
    }
    await dropCards();
    const next = { ...s, unit: s.mismatch.unit, hints: balanceHints({ displayName: s.cardName, issuer: s.issuer, rewardType: s.mismatch.unit }) };
    await patchSession({ unit: next.unit, hints: next.hints });
    return finishSync(s.tabId, next, s.mismatch, { trust: true });
}

/** Buttons on the page's status note. */
export async function onStatusAction(action) {
    if (action === "switch-type") return switchCardType();
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
    const noise = value == null ? null : noiseReason(text, value);
    if (value == null || noise) {
        await pageStatus(s.tabId, { kind: "error", title: noise ? `That's ${noise}, not a balance` : "That spot has no number", text: "Pick the balance itself.", actions: [["pick", "Pick again", true], ["close", "Close"]] });
        return { ok: false, error: noise ? `Picked ${noise}, not a balance` : "No number in the picked spot" };
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
