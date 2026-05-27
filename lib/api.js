// extension/lib/api.js — thin fetch wrapper around the CC Rewards Tracker
// REST API. Mirrors client/js/api.js: unwraps the ResponseObject envelope
// and throws { status, message, data } on non-2xx.
//
// Importable from MV3 service worker (ESM).

export async function api(baseUrl, token, path, { method = "GET", body } = {}) {
    const url = (baseUrl || "").replace(/\/$/, "") + path;

    const headers = { "Accept": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let envelope;
    try {
        envelope = await res.json();
    } catch (_e) {
        envelope = { status: res.status, message: res.statusText, data: null };
    }

    if (!res.ok) {
        const err = new Error(envelope.message || `HTTP ${res.status}`);
        err.status = envelope.status || res.status;
        err.data = envelope.data;
        throw err;
    }

    return envelope.data;
}

// Convenience wrappers — every method returns the unwrapped data payload
// (or throws). Background code uses try/catch to translate to the
// { ok, error } shape the popup messaging layer expects.
export const Tracker = {
    // Server accepts either { identifier } (preferred) or legacy { username }.
    // We send identifier so users can sign in with their email too.
    login: (base, identifier, password) =>
        api(base, null, "/api/auth/login", { method: "POST", body: { identifier, password } }),
    listCards: (base, token) =>
        api(base, token, "/api/cards"),
    getCard: (base, token, id) =>
        api(base, token, `/api/cards/${id}`),
    postTransaction: (base, token, payload) =>
        api(base, token, "/api/transactions", { method: "POST", body: payload }),
    bulkUpsertOffers: (base, token, payload) =>
        api(base, token, "/api/offers/bulk", { method: "POST", body: payload }),
    health: (base) =>
        api(base, null, "/api/health"),
};
