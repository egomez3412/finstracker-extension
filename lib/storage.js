// extension/lib/storage.js — typed wrappers over chrome.storage.local.
// Keeps all keys in one place so popup + background never disagree.

const DEFAULTS = {
    apiBase: "https://finstracker.com",
    token: null,
    user: null,                // { id, username }
    captureSession: null,      // { cardId, cardName, issuer, tabId, expiresAt, mode }
    portalOverrides: {},       // { [cardId]: { matchUrl, selector, regex? } }
    autoDetect: true,          // scrape known portals automatically on visit
    theme: "system",           // "system" | "light" | "dark"
};

export async function getState(keys = null) {
    const want = keys == null ? Object.keys(DEFAULTS) : keys;
    const stored = await chrome.storage.local.get(want);
    const out = {};
    for (const k of want) out[k] = stored[k] === undefined ? DEFAULTS[k] : stored[k];
    return out;
}

export async function setState(patch) {
    await chrome.storage.local.set(patch);
}

export async function clearAuth() {
    await chrome.storage.local.set({ token: null, user: null, captureSession: null });
}

export function onChanged(handler) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local") handler(changes);
    });
}
