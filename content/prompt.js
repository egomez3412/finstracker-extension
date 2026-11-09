/* Finstracker popup on a card site: names the cards that use this site and offers Autopilot for
 * all of them (balance, offers added to each card, benefits), or a quick sync / pick for one card.
 * Injected with window.__finsPromptPayload = { cards: [...] }. Re-injecting updates the open popup. */
(function () {
    const payload = window.__finsPromptPayload || {};
    if (window.__finsPromptInstance) { try { window.__finsPromptInstance.update(payload); } catch { /* replaced below */ } return; }
    if (document.getElementById("fins-prompt-root")) return;

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const site = location.hostname.replace(/^(www|secure|online|global|connect)\./, "");
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
            <div class="fins-prompt-actions"><button class="fins-prompt-btn fins-prompt-primary" type="button" data-act="run">Run autopilot</button></div>
            <div class="fins-prompt-one"></div>
            <p class="fins-prompt-status" aria-live="polite"></p>
        </div>`;
    document.documentElement.appendChild(host);
    const root = host.firstElementChild;
    const body = root.querySelector(".fins-prompt-body");
    const one = root.querySelector(".fins-prompt-one");
    const status = root.querySelector(".fins-prompt-status");
    const runBtn = root.querySelector("[data-act='run']");
    let current = payload;

    const cardsHere = () => current.cards || [];
    function chosenCard() {
        const cards = cardsHere();
        if (cards.length === 1) return cards[0];
        const id = one.querySelector("select")?.value;
        return cards.find((c) => c.id === id) || cards[0] || null;
    }
    function render() {
        const cards = cardsHere();
        const names = cards.map((c) => `<strong>${esc(c.displayName)}</strong>`);
        body.innerHTML = cards.length === 1
            ? `Update ${names[0]} from ${esc(site)}: balance, offers and benefits.`
            : `${cards.length} of your cards use ${esc(site)}: ${names.join(", ")}. Autopilot updates each one's balance, adds its offers and checks its benefits.`;
        runBtn.textContent = cards.length > 1 ? `Run autopilot for ${cards.length} cards` : "Run autopilot";
        one.innerHTML = `
            ${cards.length > 1 ? `<label class="fins-prompt-label">Just one card<select aria-label="Card">${cards.map((c) => `<option value="${esc(c.id)}">${esc(c.displayName)}</option>`).join("")}</select></label>` : ""}
            <div class="fins-prompt-actions">
                <button class="fins-prompt-btn" type="button" data-act="sync">Sync this page</button>
                <button class="fins-prompt-btn" type="button" data-act="pick">Pick the balance</button>
            </div>`;
    }
    function setStatus(text, kind) {
        status.className = `fins-prompt-status${kind ? ` is-${kind}` : ""}`;
        status.innerHTML = `${kind === "busy" ? '<span class="fins-prompt-spinner" aria-hidden="true"></span>' : ""}${text ? `<span>${esc(text)}</span>` : ""}`;
    }
    const busy = (on) => root.querySelectorAll("button[data-act]").forEach((b) => { b.disabled = on; });
    function remove() {
        root.classList.remove("fins-show");
        setTimeout(() => host.remove(), 260);
        window.__finsPromptInstance = null;
    }
    const send = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err?.message }));

    root.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        if (act === "run") {
            busy(true);
            setStatus("Starting autopilot…", "busy");
            const r = await send({ type: "runAutopilot", cardIds: cardsHere().map((c) => c.id), here: true });
            if (r?.ok === false) { setStatus(r.error || "Couldn't start autopilot", "error"); busy(false); return; }
            remove(); // the page's status note shows each step from here
            return;
        }
        const card = chosenCard();
        if (!card) return;
        busy(true);
        setStatus(act === "sync" ? "Reading this page…" : "Opening the picker…", "busy");
        const r = await send(act === "sync" ? { type: "syncFromActiveTab", card, tabId: null } : { type: "startPickerForCard", card });
        if (r?.ok === false) { setStatus(r.error || "Something went wrong", "error"); busy(false); return; }
        if (r?.kind === "offers") { setStatus(`${r.received || r.found} offers saved`, "ok"); setTimeout(remove, 2600); return; }
        remove(); // the status note (or the picker) takes over
    });
    root.querySelector(".fins-prompt-close").addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "collapsePrompt" }).catch(() => {}); // leaves the quick tab on the edge
        remove();
    });

    window.__finsPromptInstance = {
        update(next) { current = next || current; render(); setStatus("", ""); busy(false); },
    };
    render();
    requestAnimationFrame(() => root.classList.add("fins-show"));
})();
