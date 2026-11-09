// Finstracker's REST API (the /api/* endpoints the dashboard keeps for the extension, iOS app and CLI).
// Responses come wrapped as { status, message, data }; failures throw an Error with .status.

export async function api(baseUrl, token, path, { method = "GET", body } = {}) {
    const url = String(baseUrl || "").replace(/\/$/, "") + path;
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let envelope;
    try {
        envelope = await res.json();
    } catch {
        envelope = { status: res.status, message: res.statusText, data: null };
    }
    if (!res.ok) {
        const err = new Error(envelope?.message || `HTTP ${res.status}`);
        err.status = envelope?.status || res.status;
        err.data = envelope?.data;
        throw err;
    }
    return envelope?.data;
}

export const Tracker = {
    listCards: (base, token) => api(base, token, "/api/cards"),
    getCard: (base, token, id) => api(base, token, `/api/cards/${encodeURIComponent(id)}`),
    updateCard: (base, token, id, body) => api(base, token, `/api/cards/${encodeURIComponent(id)}`, { method: "PUT", body }),
    postTransaction: (base, token, payload) => api(base, token, "/api/transactions", { method: "POST", body: payload }),
    bulkUpsertOffers: (base, token, payload) => api(base, token, "/api/offers/bulk", { method: "POST", body: payload }),
    listCredits: (base, token) => api(base, token, "/api/perks?status=available"),
    listAllCredits: (base, token) => api(base, token, "/api/perks"),
    setCreditUsed: (base, token, id, used) => api(base, token, `/api/perks/${encodeURIComponent(id)}`, { method: "PUT", body: { used } }),
    listOffers: (base, token) => api(base, token, "/api/offers?status=active"),
    setOfferUsed: (base, token, id, used) => api(base, token, `/api/offers/${encodeURIComponent(id)}/used`, { method: "POST", body: { used } }),
    health: (base) => api(base, null, "/api/health"),
};

/** Signed-out or expired session errors, which send the panel back to sign-in. */
export const isAuthError = (err) => err?.status === 401 || /not logged|unauthor|session expired|authentication required/i.test(err?.message || err || "");
