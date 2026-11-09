// Points sync: open the issuer portal, wait for the user to sign in, read the balance and post
// the difference to Finstracker as an earn or redeem.
import { Tracker } from "../api.js";
import { balanceChange, parseNumber } from "../parse.js";
import { loadPortals, resolvePortal, urlMatches } from "../portals.js";
import { getState, setState } from "../storage.js";
import { dropCards, session } from "./account.js";
import { injectPicker, notify, readBalance, showsSignIn, watchBalance } from "./tabs.js";

const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;
const watching = new Map(); // tabId → { url, startedAt }, so one page is not watched twice

export const forgetTab = (tabId) => watching.delete(tabId);

async function patchSession(patch) {
    const { captureSession } = await getState(["captureSession"]);
    if (captureSession) await setState({ captureSession: { ...captureSession, ...patch } });
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
        await Tracker.postTransaction(apiBase, token, {
            cardId: card.id,
            type: change.type,
            unit: change.unit,
            amount: change.amount,
            note: `Synced from the ${fresh.issuer} portal`,
        });
    } catch (err) {
        return { ok: false, error: err.message || "Couldn't save the new balance" };
    }
    await dropCards();
    return { ok: true, target: change.target, current: change.current, delta: change.delta, type: change.type };
}

/** Open the card's portal in a new tab and start watching it. */
export async function startCapture({ card, mode = "auto" }) {
    const { portalOverrides } = await getState(["portalOverrides"]);
    const portal = resolvePortal(card, portalOverrides, await loadPortals());
    const url = portal && (portal.loginUrl || portal.pointsUrlHint || portal.capturedUrl);
    if (!url) return { ok: false, error: `No portal is set up for ${card.issuer}. Open its rewards page and use Pick the balance.` };

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
        mode, // "auto" reads on navigation; "configure" waits for the picker
        startedAt: Date.now(),
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
        status: "opening",
        statusLabel: `Opening ${card.issuer}…`,
        currentUrl: url,
    };
    await setState({ captureSession });
    return { ok: true, session: captureSession };
}

export async function cancelCapture() {
    await setState({ captureSession: null });
    return { ok: true };
}

/** Remember the selector that worked, so the next sync reads it directly. Never replaces a user pick. */
async function learnSelector(cardId, url, selector, fallbackMatch) {
    const { portalOverrides } = await getState(["portalOverrides"]);
    if (portalOverrides?.[cardId]?.source === "user-picker") return;
    let matchUrl = fallbackMatch;
    try { matchUrl = `${new URL(url).origin}/*`; } catch { /* keep the issuer pattern */ }
    await setState({
        portalOverrides: { ...(portalOverrides || {}), [cardId]: { matchUrl, capturedUrl: url, selector, regex: null, source: "auto-learned", learnedAt: Date.now() } },
    });
}

/** A tab in the capture session navigated: read the balance once the portal page settles. */
export async function onCaptureTabNavigated(tabId, url) {
    const { captureSession: s } = await getState(["captureSession"]);
    if (!s || s.kind === "offers" || s.tabId !== tabId) return;
    if (Date.now() > s.expiresAt) { await setState({ captureSession: null }); return; }
    if (["synced", "configured"].includes(s.status)) return;
    if (!urlMatches(s.matchUrl, url)) {
        await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${s.issuer}`, currentUrl: url });
        return;
    }
    if (s.mode === "configure") return;

    const current = watching.get(tabId);
    if (current && current.url === url && Date.now() - current.startedAt < 120000) return;
    watching.set(tabId, { url, startedAt: Date.now() });
    await patchSession({ status: "watching", statusLabel: `Reading ${s.cardName}…`, currentUrl: url });

    let reading;
    try {
        reading = await watchBalance(tabId, s.selector, s.regex, s.unit);
    } catch (err) {
        console.warn("[finstracker] watcher failed", err);
        return;
    } finally {
        watching.delete(tabId);
    }

    if (!reading || reading.__awaitingLogin) {
        if (reading?.__awaitingLogin || (await showsSignIn(tabId))) {
            await patchSession({ status: "awaiting-login", statusLabel: `Sign in to ${s.issuer}`, lastError: null, currentUrl: url });
        } else {
            await patchSession({ status: "error", lastError: "Couldn't find the balance on this page. Open the rewards page or pick the balance.", currentUrl: url });
        }
        return;
    }
    const value = parseNumber(reading.text);
    if (value == null) {
        await patchSession({ status: "error", lastError: `Found “${reading.text}” but no number`, currentUrl: url });
        return;
    }

    const card = { id: s.cardId, issuer: s.issuer, displayName: s.cardName };
    const result = await syncCardBalance(card, value);
    if (result.ok && reading.via === "heuristic" && reading.selector) {
        await learnSelector(s.cardId, url, reading.selector, s.matchUrl).catch((err) => console.warn("[finstracker] learn failed", err));
    }
    await patchSession({
        status: result.ok ? "synced" : "error",
        lastScrape: { value, text: reading.text, selector: reading.selector, at: Date.now() },
        lastError: result.ok ? null : result.error,
        currentUrl: url,
    });
    if (result.ok) {
        notify("Finstracker", result.noop ? `${s.cardName} is already up to date (${value.toLocaleString()})` : `${s.cardName} synced to ${value.toLocaleString()}`);
    } else {
        notify("Finstracker: sync failed", result.error);
    }
}

/** Read the balance on a tab the user already has open (the "Read this tab" action). */
export async function readPointsFromTab(card, tabId, url) {
    const { portalOverrides } = await getState(["portalOverrides"]);
    const portal = resolvePortal(card, portalOverrides, await loadPortals());
    if (!portal || !urlMatches(portal.matchUrl, url)) return null;
    const reading = await readBalance(tabId, portal.selector, portal.regex, card.rewardType);
    if (!reading || reading.__awaitingLogin) return null;
    const value = parseNumber(reading.text);
    if (value == null) return { ok: false, error: `Found “${reading.text}” but no number` };
    return { ...(await syncCardBalance(card, value)), kind: "points", scraped: { value, text: reading.text, selector: reading.selector } };
}

/** Show the picker on the capture tab (from the panel's status strip). */
export async function openPickerOnCaptureTab() {
    const { captureSession: s } = await getState(["captureSession"]);
    if (!s?.tabId) return { ok: false, error: "No sync in progress" };
    await injectPicker(s.tabId);
    await chrome.tabs.update(s.tabId, { active: true });
    return { ok: true };
}

/** Start the picker on a page the user is already on (from the on-page prompt or the panel). */
export async function openPickerOnTab(card, tabId) {
    const tab = await chrome.tabs.get(tabId);
    const { portalOverrides } = await getState(["portalOverrides"]);
    const portal = resolvePortal(card, portalOverrides, await loadPortals());
    await setState({
        captureSession: {
            cardId: card.id,
            cardName: card.displayName,
            issuer: card.issuer,
            unit: card.rewardType || null,
            tabId,
            matchUrl: portal?.matchUrl || `${new URL(tab.url).origin}/*`,
            selector: portal?.selector || null,
            regex: portal?.regex || null,
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

/** The user clicked the balance in the picker: save that spot and sync the value. */
export async function applyPickerResult({ selector, regex, text }) {
    const { captureSession: s, portalOverrides } = await getState(["captureSession", "portalOverrides"]);
    if (!s) return { ok: false, error: "No sync in progress" };
    const tab = await chrome.tabs.get(s.tabId);
    const override = {
        matchUrl: tab.url ? `${new URL(tab.url).origin}/*` : s.matchUrl,
        capturedUrl: tab.url || null,
        selector,
        regex: regex || null,
        source: "user-picker",
    };
    await setState({
        portalOverrides: { ...(portalOverrides || {}), [s.cardId]: override },
        captureSession: { ...s, selector, matchUrl: override.matchUrl, regex: override.regex, mode: "auto", capturedUrl: override.capturedUrl, status: "configured", statusLabel: "Balance spot saved" },
    });
    const value = parseNumber(text);
    if (value == null) return { ok: true, override };
    const sync = await syncCardBalance({ id: s.cardId, issuer: s.issuer, displayName: s.cardName }, value);
    if (sync.ok) await patchSession({ status: "synced", lastScrape: { value, text, selector, at: Date.now() }, lastError: null });
    return { ok: true, override, sync };
}

export async function clearOverride(cardId) {
    const { portalOverrides } = await getState(["portalOverrides"]);
    if (cardId && portalOverrides?.[cardId]) {
        const next = { ...portalOverrides };
        delete next[cardId];
        await setState({ portalOverrides: next });
    }
    return { ok: true };
}
