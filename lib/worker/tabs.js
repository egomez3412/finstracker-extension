// Talking to the page being synced: the reader content script (content/reader.js), the status note
// (content/status.js), the element picker and the offers reader. Scripts run in the extension's
// isolated world, so bank pages' Content-Security-Policy cannot block them.
import { addOffersToCard, expandOffersPage, offersPageScraper } from "../inject/offers.js";

/** Inject into every frame we may access; fall back to the top frame when some frames refuse. */
async function inject(tabId, details, allFrames = true) {
    if (allFrames) {
        try {
            return await chrome.scripting.executeScript({ ...details, target: { tabId, allFrames: true } });
        } catch { /* a frame we cannot access: retry the top frame alone */ }
    }
    return chrome.scripting.executeScript({ ...details, target: { tabId } });
}

async function insertCss(tabId, files, allFrames = false) {
    try {
        await chrome.scripting.insertCSS({ target: { tabId, allFrames }, files });
    } catch {
        if (allFrames) await chrome.scripting.insertCSS({ target: { tabId }, files });
        else throw new Error("Can't reach this page");
    }
}

/** Call window.__finsReader[name](...args) in the page, loading the reader first. */
async function callReader(tabId, name, args, allFrames = true) {
    await inject(tabId, { files: ["content/reader.js"] }, allFrames);
    return inject(tabId, { func: (fn, fnArgs) => (window.__finsReader ? window.__finsReader[fn](...fnArgs) : null), args: [name, args] }, allFrames);
}

/** A selector hit beats a scored guess; between guesses the higher score wins. */
export function bestReading(results) {
    let best = null;
    let awaitingLogin = false;
    for (const r of results || []) {
        const v = r?.result;
        if (!v) continue;
        if (v.__awaitingLogin) { awaitingLogin = true; continue; }
        if (!best || (best.via === "heuristic" && v.via !== "heuristic") || (best.via === "heuristic" && v.via === "heuristic" && (v.score || 0) > (best.score || 0))) {
            best = { ...v, frameId: r.frameId };
        }
    }
    if (best) return best;
    return awaitingLogin ? { __awaitingLogin: true } : null;
}

/** Read the balance once, right now. */
export async function readBalance(tabId, selector, regex, unit, hints = null) {
    return bestReading(await callReader(tabId, "extract", [selector, regex || null, unit || null, hints]));
}

/** Watch the page until the balance stops changing (or the time runs out). */
export async function watchBalance(tabId, selector, regex, unit, timeoutMs = 25000, hints = null) {
    return bestReading(await callReader(tabId, "watch", [selector, regex || null, unit || null, timeoutMs, hints]));
}

/** True when any frame shows a sign-in or verification form. */
export async function showsSignIn(tabId) {
    try {
        return (await callReader(tabId, "signInShown", [])).some((r) => r?.result === true);
    } catch {
        return false;
    }
}

/** Wait until the page stops changing (bank pages draw their content after loading). */
export async function pageSettled(tabId) {
    try { await callReader(tabId, "settle", [800, 6000], false); } catch { /* navigating */ }
}

/** The rewards link on the page (top frame): { href } to open, { clicked } when it was a button, or null. */
export async function findRewardsLink(tabId, hints, avoid) {
    try {
        const [r] = await callReader(tabId, "findRewardsLink", [hints || [], avoid || []], false);
        return r?.result || null;
    } catch {
        return null;
    }
}

/** Benefits with usage, from every frame (see reader.readBenefits). */
export async function readBenefitsOn(tabId) {
    try {
        return (await callReader(tabId, "readBenefits", [])).flatMap((r) => (Array.isArray(r?.result) ? r.result : []));
    } catch {
        return [];
    }
}

/** Open collapsed benefit details on the page (top frame). */
export async function expandDetailsOn(tabId) {
    try { await callReader(tabId, "expandDetails", [], false); } catch { /* page navigating */ }
}

/** Rewards activity lines from the frame that has the most. */
export async function readActivityOn(tabId, unit) {
    try {
        return (await callReader(tabId, "readActivity", [unit || "points"])).reduce((best, r) => (Array.isArray(r?.result) && r.result.length > best.length ? r.result : best), []);
    } catch {
        return [];
    }
}

/** Whether the balance just found (in that frame) sits next to this card's name. */
export async function foundNearCardOn(tabId, frameId, words) {
    try {
        const [r] = await chrome.scripting.executeScript({ target: frameId ? { tabId, frameIds: [frameId] } : { tabId }, func: (w) => Boolean(window.__finsReader?.foundNearCard(w)), args: [words] });
        return Boolean(r?.result);
    } catch {
        return false;
    }
}

/** Which of these cards the page shows ({ id, strong } or null). See reader.detectCard. */
/** The cards the site lists for this login ([{ text }]), from its card switcher and account tiles. */
export async function listSiteCardsOn(tabId) {
    try {
        const [r] = await callReader(tabId, "listSiteCards", [], false);
        return Array.isArray(r?.result) ? r.result : [];
    } catch {
        return [];
    }
}

export async function detectCardOn(tabId, cards) {
    try {
        const [r] = await callReader(tabId, "detectCard", [cards], false);
        return r?.result || null;
    } catch {
        return null;
    }
}

/** Select a card in the page's card switcher (top frame). See reader.switchAccount. */
export async function switchAccountOn(tabId, words, others) {
    try {
        const [r] = await callReader(tabId, "switchAccount", [words, others], false);
        return r?.result || { ok: false, reason: "no-switcher" };
    } catch {
        return { ok: false, reason: "no-switcher" };
    }
}

/** A same-site link whose text has one of the words (top frame). */
export async function findLinkOn(tabId, words, avoid) {
    try {
        const [r] = await callReader(tabId, "findLink", [words, avoid || []], false);
        return r?.result || null;
    } catch {
        return null;
    }
}

/** Outline the balance that was found, in the frame it was found in. */
export async function highlightBalance(tabId, frameId, selector) {
    try {
        const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
        await chrome.scripting.executeScript({ target, func: (sel) => window.__finsReader?.highlight(sel), args: [selector] });
    } catch { /* page gone */ }
}

export async function clearHighlight(tabId) {
    try {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__finsReader?.clearHighlight() });
    } catch { /* page gone */ }
}

/** Show (state) or hide (null) the Finstracker status note on the page. Never throws. */
export async function pageStatus(tabId, state) {
    try {
        await insertCss(tabId, ["content/prompt.css"]);
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content/status.js"] });
        await chrome.scripting.executeScript({ target: { tabId }, func: (s) => (s ? window.__finsStatus.show(s) : window.__finsStatus.hide()), args: [state] });
    } catch { /* restricted page (or no access yet): the side panel still shows the status */ }
}

/** Every offer tile on the page, from whichever frame found the most. */
export async function readOffers(tabId) {
    try { await inject(tabId, { func: expandOffersPage }); } catch { /* best effort */ }
    let results = [];
    try { results = await inject(tabId, { func: offersPageScraper }); } catch { return []; }
    return results.reduce((best, r) => (Array.isArray(r?.result) && r.result.length > best.length ? r.result : best), []);
}

/** Click "Add to Card" on each offer tile (all frames we may reach). */
export async function addOffers(tabId, max = 300) {
    try {
        const results = await inject(tabId, { func: addOffersToCard, args: [max] });
        const sum = (k) => results.reduce((n, r) => n + (r?.result?.[k] || 0), 0);
        return { added: sum("added"), failed: sum("failed"), remaining: sum("remaining") };
    } catch {
        return { added: 0, failed: 0, remaining: 0 };
    }
}

/** Add a stylesheet and script from the extension to a tab, handing the script a payload first. */
export async function injectWidget(tabId, { css, js, payloadKey, payload }) {
    if (css) await insertCss(tabId, [].concat(css));
    if (payloadKey) await chrome.scripting.executeScript({ target: { tabId }, func: (key, value) => { window[key] = value; }, args: [payloadKey, payload] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [js] });
}

/** The element picker overlay: the top frame always, other frames when we may. */
export async function injectPicker(tabId, payload = {}) {
    await insertCss(tabId, ["content/picker.css"], true);
    await inject(tabId, { files: ["content/reader.js"] }); // the picker's suggestions come from the reader
    await inject(tabId, { func: (p) => { try { window.__finsPickerCleanup?.(); window.__finsPickerActive = false; window.__finsPickerPayload = p; } catch { /* noop */ } }, args: [payload] });
    await inject(tabId, { files: ["content/picker.js"] });
}

/** Close the picker in every frame (after a pick in one of them, or on cancel). */
export async function removePicker(tabId) {
    try { await inject(tabId, { func: () => { try { window.__finsPickerCleanup?.(); } catch { /* noop */ } } }); } catch { /* page gone */ }
}

export async function notify(title, message) {
    try {
        await chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title, message });
    } catch { /* the panel shows the result as well */ }
}

export async function setBadge(tabId, text, color = "#1d6b4a") {
    try {
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
        await chrome.action.setBadgeText({ tabId, text: text || "" });
    } catch { /* tab gone */ }
}
