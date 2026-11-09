/* Sync prompt shown on a card issuer's site when you have a card from that issuer.
 * Injected by the service worker with window.__finsPromptPayload = { issuer, cards: [...] }.
 * Re-injecting updates the open prompt instead of adding a second one. */
(function () {
    const payload = window.__finsPromptPayload || {};
    if (window.__finsPromptInstance) { try { window.__finsPromptInstance.update(payload); } catch { /* replaced below */ } return; }
    if (document.getElementById("fins-prompt-root")) return;

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const host = document.createElement("div");
    host.id = "fins-prompt-root";
    host.innerHTML = `
        <div class="fins-prompt" role="dialog" aria-label="Finstracker">
            <div class="fins-prompt-head">
                <img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="20" height="20">
                <span class="fins-prompt-title">Finstracker</span>
                <button class="fins-prompt-close" type="button" aria-label="Close">×</button>
            </div>
            <div class="fins-prompt-body"></div>
            <div class="fins-prompt-actions">
                <button class="fins-prompt-btn fins-prompt-primary" type="button" data-act="sync">Sync balance</button>
                <button class="fins-prompt-btn" type="button" data-act="pick">Pick the balance</button>
            </div>
            <p class="fins-prompt-status" aria-live="polite"></p>
        </div>`;
    document.documentElement.appendChild(host);
    const root = host.firstElementChild;
    const body = root.querySelector(".fins-prompt-body");
    const status = root.querySelector(".fins-prompt-status");
    const syncBtn = root.querySelector("[data-act='sync']");
    const pickBtn = root.querySelector("[data-act='pick']");
    let current = payload;

    function chosenCard() {
        const cards = current.cards || [];
        if (cards.length === 1) return cards[0];
        const id = body.querySelector("select")?.value;
        return cards.find((c) => c.id === id) || null;
    }
    function renderBody() {
        const cards = current.cards || [];
        body.innerHTML = cards.length === 1
            ? `Sync <strong>${esc(cards[0].displayName)}</strong> from this page?`
            : `<label>Sync from this page<select aria-label="Card">${cards.map((c) => `<option value="${esc(c.id)}">${esc(c.displayName)}</option>`).join("")}</select></label>`;
    }
    function setStatus(text, kind) {
        status.className = `fins-prompt-status${kind ? ` is-${kind}` : ""}`;
        status.innerHTML = `${kind === "busy" ? '<span class="fins-prompt-spinner" aria-hidden="true"></span>' : ""}${text ? `<span>${esc(text)}</span>` : ""}`;
    }
    const busy = (on) => { syncBtn.disabled = on; pickBtn.disabled = on; };
    function close() {
        root.classList.remove("fins-show");
        setTimeout(() => host.remove(), 260);
        window.__finsPromptInstance = null;
    }

    syncBtn.addEventListener("click", async () => {
        const card = chosenCard();
        if (!card) return;
        busy(true);
        setStatus("Reading this page…", "busy");
        try {
            const r = await chrome.runtime.sendMessage({ type: "syncFromActiveTab", card, tabId: null });
            if (!r?.ok) { setStatus(r?.error || "Sync failed", "error"); busy(false); return; }
            if (r.kind === "offers") { setStatus(`${r.received || r.offers} offers saved`, "ok"); setTimeout(close, 2600); return; }
            close(); // the status note takes over while the page is read
        } catch (err) {
            setStatus(err?.message || "Sync failed", "error");
            busy(false);
        }
    });
    pickBtn.addEventListener("click", async () => {
        const card = chosenCard();
        if (!card) return;
        setStatus("Opening the picker…", "busy");
        try {
            const r = await chrome.runtime.sendMessage({ type: "startPickerForCard", card });
            if (!r?.ok) { setStatus(r?.error || "Couldn't open the picker", "error"); return; }
            close();
        } catch (err) {
            setStatus(err?.message || "Couldn't open the picker", "error");
        }
    });
    root.querySelector(".fins-prompt-close").addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "dismissPromptForOrigin", origin: location.origin }).catch(() => {});
        close();
    });

    window.__finsPromptInstance = {
        update(next) { current = next || current; renderBody(); setStatus("", ""); busy(false); },
    };
    renderBody();
    requestAnimationFrame(() => root.classList.add("fins-show"));
})();
