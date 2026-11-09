// Everything the extension keeps in chrome.storage.local, with defaults in one place.

export const PRODUCTION = "https://finstracker.com";

const DEFAULTS = {
    apiBase: PRODUCTION,
    token: null,
    user: null, // { id, username, email }
    captureSession: null, // the sync in progress, shown in the panel's status strip
    portalOverrides: {}, // { [cardId]: { matchUrl, selector, regex?, capturedUrl?, source } }
    autoDetect: true, // offer to sync on issuer portals
    checkoutHints: false, // best-card chip on checkout pages (needs site access)
    theme: "system", // "system" | "light" | "dark"
    cardsCache: null, // last /api/cards answer, for the toolbar badge and instant panel paint
    cardsCachedAt: 0,
};

export async function getState(keys = null) {
    const want = keys == null ? Object.keys(DEFAULTS) : keys;
    const stored = await chrome.storage.local.get(want);
    const out = {};
    for (const k of want) out[k] = stored[k] === undefined ? DEFAULTS[k] : stored[k];
    return out;
}

export const setState = (patch) => chrome.storage.local.set(patch);

export const clearAuth = () => chrome.storage.local.set({ token: null, user: null, captureSession: null, cardsCache: null, cardsCachedAt: 0 });

export function onChanged(handler) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local") handler(changes);
    });
}
