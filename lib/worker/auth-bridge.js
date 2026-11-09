// Sign-in hand-off: finstracker.com/login.html?source=extension sends the session token here after
// the user signs in on the website (password, Google, Turnstile all happen there, never in the
// extension). Only origins listed in the manifest's externally_connectable can reach this.
import { clearAuth, setState } from "../storage.js";

const ALLOWED = ["https://finstracker.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5175", "http://127.0.0.1:5175"];

export function isAllowedSender(sender) {
    try {
        const u = new URL(sender?.url || sender?.origin || "");
        if (ALLOWED.includes(`${u.protocol}//${u.host}`)) return true;
        return u.protocol === "https:" && /(^|\.)finstracker\.com$/i.test(u.hostname);
    } catch {
        return false;
    }
}

export function onExternalMessage(msg, sender, sendResponse) {
    if (!isAllowedSender(sender)) { sendResponse({ ok: false, error: "Forbidden sender" }); return false; }
    (async () => {
        switch (msg?.type) {
            case "ping":
                return { ok: true, version: chrome.runtime.getManifest().version };
            case "extensionAuthHandoff": {
                const { token, user, apiBase } = msg;
                if (typeof token !== "string" || !token) return { ok: false, error: "Missing token" };
                if (!user || typeof user !== "object") return { ok: false, error: "Missing user" };
                // Talk to the server that issued the token.
                const sent = new URL(sender.url);
                const base = typeof apiBase === "string" && /^https?:\/\//.test(apiBase) ? apiBase.replace(/\/$/, "") : `${sent.protocol}//${sent.host}`;
                await setState({ apiBase: base, token, user, cardsCache: null, cardsCachedAt: 0 });
                return { ok: true };
            }
            case "extensionAuthSignOut":
                await clearAuth();
                return { ok: true };
            default:
                return { ok: false, error: "Unknown message" };
        }
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
}
