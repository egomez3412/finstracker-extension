// Running the page scripts in a tab and picking the best answer across its frames.
import { pageExtractor } from "../inject/extractor.js";
import { authFormProbe, pageWatcher } from "../inject/watcher.js";
import { expandOffersPage, offersPageScraper } from "../inject/offers.js";

async function runInFrames(tabId, func, args = []) {
    return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func, args });
}

/** A selector hit beats a heuristic guess; between guesses the higher score wins. */
export function bestReading(results) {
    let best = null;
    let awaitingLogin = false;
    for (const r of results || []) {
        const v = r?.result;
        if (!v) continue;
        if (v.__awaitingLogin) { awaitingLogin = true; continue; }
        if (!best) { best = v; continue; }
        if (best.via === "heuristic" && v.via !== "heuristic") { best = v; continue; }
        if (best.via === "heuristic" && v.via === "heuristic" && (v.score || 0) > (best.score || 0)) best = v;
    }
    if (best) return best;
    return awaitingLogin ? { __awaitingLogin: true } : null;
}

/** Read the balance once, right now. */
export async function readBalance(tabId, selector, regex, unit, hints = null) {
    return bestReading(await runInFrames(tabId, pageExtractor, [selector, regex || null, unit || null, hints]));
}

/** Watch the page until the balance stops changing (or the time runs out). */
export async function watchBalance(tabId, selector, regex, unit, timeoutMs = 120000, hints = null) {
    const results = await runInFrames(tabId, pageWatcher, [pageExtractor.toString(), selector, regex || null, unit || null, timeoutMs, hints]);
    return bestReading(results);
}

/** True when any frame shows a sign-in or verification form. */
export async function showsSignIn(tabId) {
    try {
        return (await runInFrames(tabId, authFormProbe)).some((r) => r?.result === true);
    } catch {
        return false;
    }
}

/** Every offer tile on the page, from whichever frame found the most. */
export async function readOffers(tabId) {
    try { await runInFrames(tabId, expandOffersPage); } catch { /* best effort */ }
    let results = [];
    try { results = await runInFrames(tabId, offersPageScraper); } catch { return []; }
    return results.reduce((best, r) => (Array.isArray(r?.result) && r.result.length > best.length ? r.result : best), []);
}

/** Add a stylesheet and script from the extension to a tab, handing the script a payload first. */
export async function injectWidget(tabId, { css, js, payloadKey, payload, allFrames = false }) {
    const target = { tabId, allFrames };
    if (css) await chrome.scripting.insertCSS({ target, files: [].concat(css) });
    if (payloadKey) await chrome.scripting.executeScript({ target, func: (key, value) => { window[key] = value; }, args: [payloadKey, payload] });
    await chrome.scripting.executeScript({ target, files: [js] });
}

/** The element picker overlay, in every frame of the tab. */
export async function injectPicker(tabId) {
    const target = { tabId, allFrames: true };
    await chrome.scripting.insertCSS({ target, files: ["content/picker.css"] });
    await chrome.scripting.executeScript({ target, func: () => { try { window.__finsPickerActive = false; } catch { /* noop */ } } });
    await chrome.scripting.executeScript({ target, files: ["content/picker.js"] });
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
