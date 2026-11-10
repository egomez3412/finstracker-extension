/* Finstracker popup on a card site: names the cards that use this site and offers Autopilot for
 * all of them (balance, offers added to each card, benefits), or a quick sync / pick for one card.
 * Injected with window.__finsPromptPayload = { cards: [...] }. Re-injecting updates the open popup. */
(function () {
    const payload = window.__finsPromptPayload || {};
    if (window.__finsPromptInstance) { try { window.__finsPromptInstance.update(payload); } catch { /* replaced below */ } return; }
    if (payload.update) return; // a late update for a popup the user already closed: don't reopen it
    // A popup left by an earlier copy of the extension (reloaded or updated): replace it.
    document.querySelectorAll("#fins-prompt-root").forEach((n) => n.remove());
    const alive = () => { try { return Boolean(chrome.runtime?.id); } catch { return false; } }; // false once the extension is reloaded or updated
    let iconUrl = "";
    try { iconUrl = chrome.runtime.getURL("icons/icon-48.png"); } catch { /* extension reloaded */ }

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const site = location.hostname.replace(/^(www|secure|online|global|connect)\./, "");
    const host = document.createElement("div");
    host.id = "fins-prompt-root";
    host.innerHTML = `
        <div class="fins-prompt" role="dialog" aria-label="Finstracker">
            <div class="fins-prompt-head">
                ${iconUrl ? `<img src="${iconUrl}" alt="" width="20" height="20">` : ""}
                <span class="fins-prompt-title">Finstracker</span>
                <button class="fins-prompt-close" type="button" aria-label="Close">×</button>
            </div>
            <div class="fins-prompt-body"></div>
            <div class="fins-prompt-new"></div>
            <div class="fins-prompt-actions"><button class="fins-prompt-btn fins-prompt-primary" type="button" data-act="run">Run autopilot</button></div>
            <div class="fins-prompt-one"></div>
            <p class="fins-prompt-status" aria-live="polite"></p>
        </div>`;
    document.documentElement.appendChild(host);
    // Some sites redraw the whole page and drop anything added to it: put this back until it's closed.
    const keep = new MutationObserver(() => {
        if (!alive()) { keep.disconnect(); host.remove(); return; } // this copy of the extension was replaced
        if (!host.isConnected) document.documentElement.appendChild(host);
    });
    keep.observe(document.documentElement, { childList: true });
    const root = host.firstElementChild;
    const body = root.querySelector(".fins-prompt-body");
    const one = root.querySelector(".fins-prompt-one");
    const fresh = root.querySelector(".fins-prompt-new");
    const status = root.querySelector(".fins-prompt-status");
    const runBtn = root.querySelector("[data-act='run']");
    let current = payload;

    const cardsHere = () => current.cards || [];
    const viewing = () => cardsHere().find((c) => c.id === current.current) || null;
    function chosenCard() {
        const cards = cardsHere();
        if (cards.length === 1) return cards[0];
        const id = one.querySelector("select")?.value;
        return cards.find((c) => c.id === id) || viewing() || cards[0] || null;
    }
    function renderLink() {
        // None of the user's cards is linked to this bank's site yet: ask which ones use it.
        const all = current.allCards || [];
        body.innerHTML = `Which of your cards use <strong>${esc(site)}</strong>? Finstracker will remember them for this site.
            <div class="fins-prompt-checks">${all.map((c) => `<label><input type="checkbox" value="${esc(c.id)}"${(current.preselect || []).includes(c.id) ? " checked" : ""}> ${esc(c.displayName)}</label>`).join("")}</div>`;
        runBtn.textContent = "Save and run autopilot";
        runBtn.dataset.act = "link-run";
        one.innerHTML = `<div class="fins-prompt-actions"><button class="fins-prompt-btn" type="button" data-act="link">Save</button></div>`;
    }
    // No cards in Finstracker yet: the cards this site lists, to add and run in one go.
    function renderStart() {
        const list = current.newCards || [];
        body.innerHTML = !current.scanned ? `Looking for your cards on <strong>${esc(site)}</strong>…`
            : list.length ? `Finstracker found ${list.length === 1 ? "a card" : `${list.length} cards`} on <strong>${esc(site)}</strong>. Add ${list.length === 1 ? "it" : "them"} to Finstracker and autopilot updates each one's balance, adds its offers and checks its benefits.`
            : current.canFind ? `None of your cards are in Finstracker yet. Finstracker can look for them on <strong>${esc(site)}</strong> (it opens the site's card list).`
            : `Sign in to <strong>${esc(site)}</strong> and Finstracker will find your cards here.`;
        runBtn.textContent = list.length ? (list.length === 1 ? "Add card and run autopilot" : "Add cards and run autopilot") : "Find my cards";
        runBtn.dataset.act = list.length ? "add-run" : "find-cards";
        runBtn.hidden = !list.length && !current.canFind;
        one.innerHTML = "";
    }
    // Cards the site lists that aren't in Finstracker yet: add them (checked by default) or hide them.
    function renderNew() {
        const list = current.newCards || [];
        if (current.mode === "start") {
            // The list only: the popup's main button adds and runs them.
            fresh.innerHTML = list.length ? `<div class="fins-prompt-checks">${list.map((c) => `<label><input type="checkbox" data-new value="${esc(c.key)}" checked> ${esc(c.name)}${c.last4 ? ` <span class="fins-prompt-mask">•••• ${esc(c.last4)}</span>` : ""}</label>`).join("")}</div>
                <div class="fins-prompt-actions"><button class="fins-prompt-btn fins-prompt-quiet" type="button" data-act="ignore-new">None of these are mine</button></div>` : "";
            return;
        }
        fresh.innerHTML = list.length ? `<div class="fins-prompt-newhead">${list.length === 1 ? "A card" : `${list.length} cards`} on ${esc(site)} ${list.length === 1 ? "isn't" : "aren't"} in Finstracker yet</div>
            <div class="fins-prompt-checks">${list.map((c) => `<label><input type="checkbox" data-new value="${esc(c.key)}" checked> ${esc(c.name)}${c.last4 ? ` <span class="fins-prompt-mask">•••• ${esc(c.last4)}</span>` : ""}</label>`).join("")}</div>
            <div class="fins-prompt-actions"><button class="fins-prompt-btn" type="button" data-act="add-new">${list.length === 1 ? "Add card" : "Add cards"}</button><button class="fins-prompt-btn fins-prompt-quiet" type="button" data-act="ignore-new">Not mine</button></div>` : "";
    }
    function render() {
        renderNew();
        if (current.mode === "start") return renderStart();
        if (current.mode === "link") return renderLink();
        runBtn.dataset.act = "run";
        runBtn.hidden = false;
        const cards = cardsHere();
        const names = cards.map((c) => `<strong>${esc(c.displayName)}</strong>`);
        const on = viewing();
        body.innerHTML = cards.length === 1
            ? `Update ${names[0]} from ${esc(site)}: balance, offers and benefits.`
            : `${on ? `You're viewing <strong>${esc(on.displayName)}</strong>. ` : ""}${cards.length} of your cards use ${esc(site)}: ${names.join(", ")}. Autopilot updates each one's balance, adds its offers and checks its benefits.`;
        runBtn.textContent = cards.length > 1 ? `Run autopilot for ${cards.length} cards` : "Run autopilot";
        one.innerHTML = `
            ${cards.length > 1 ? `<label class="fins-prompt-label">Just one card<select aria-label="Card">${cards.map((c) => `<option value="${esc(c.id)}"${c.id === current.current ? " selected" : ""}>${esc(c.displayName)}${c.id === current.current ? " (on screen)" : ""}</option>`).join("")}</select></label>` : ""}
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
        keep.disconnect();
        root.classList.remove("fins-show");
        setTimeout(() => host.remove(), 260);
        window.__finsPromptInstance = null;
    }
    const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err?.message })); } catch (err) { return Promise.resolve({ ok: false, error: "Finstracker was updated. Reload this page." }); } };

    root.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        if (act === "add-new" || act === "ignore-new") {
            const boxes = [...fresh.querySelectorAll("input[data-new]")];
            const keys = (act === "add-new" ? boxes.filter((b) => b.checked) : boxes).map((b) => b.value);
            if (!keys.length) { setStatus("Tick at least one card", "error"); return; }
            busy(true);
            setStatus(act === "add-new" ? `Adding ${keys.length === 1 ? "the card" : `${keys.length} cards`}…` : "", act === "add-new" ? "busy" : "");
            const r = await send({ type: act === "add-new" ? "addSiteCards" : "ignoreSiteCards", keys });
            busy(false);
            if (r?.ok === false) { setStatus(r.error || "Couldn't add the cards", "error"); return; }
            if (act === "add-new") setStatus(`Added ${r.added.map((c) => c.displayName).join(", ")}${r.failed?.length ? ` · couldn't add ${r.failed.join(", ")}` : ""}`, "ok");
            current = { ...current, newCards: (current.newCards || []).filter((c) => !keys.includes(c.key)) };
            if (current.mode === "start") render(); else renderNew();
            return; // the popup is redrawn with the added cards
        }
        if (act === "find-cards") {
            busy(true);
            setStatus("Looking for your cards…", "busy");
            const r = await send({ type: "findCardsForPrompt" });
            busy(false);
            setStatus(r?.ok === false ? r.error || "Couldn't look for cards" : r?.found ? "" : "No cards found on this page", r?.ok === false || !r?.found ? "error" : "");
            return; // the popup is redrawn with what was found
        }
        if (act === "add-run") {
            const keys = [...fresh.querySelectorAll("input[data-new]")].filter((b) => b.checked).map((b) => b.value);
            if (!keys.length) { setStatus("Tick at least one card", "error"); return; }
            busy(true);
            setStatus(`Adding ${keys.length === 1 ? "the card" : `${keys.length} cards`}…`, "busy");
            const r = await send({ type: "addSiteCards", keys, run: true });
            if (r?.ok === false) { setStatus(r.error || "Couldn't add the cards", "error"); busy(false); return; }
            remove(); // autopilot's board takes over
            return;
        }
        if (act === "link" || act === "link-run") {
            const ids = [...body.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
            if (!ids.length) { setStatus("Tick at least one card", "error"); return; }
            busy(true);
            setStatus("Saving…", "busy");
            const r = await send({ type: "linkCardsToSite", cardIds: ids, run: act === "link-run" });
            if (r?.ok === false) { setStatus(r.error || "Couldn't save", "error"); busy(false); return; }
            remove(); // the regular popup (or autopilot) takes over
            return;
        }
        if (act === "run") {
            busy(true);
            setStatus("Starting autopilot…", "busy");
            const r = await send({ type: "runAutopilot", cardIds: cardsHere().map((c) => c.id), here: true, current: current.current || null });
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
        try { chrome.runtime.sendMessage({ type: "collapsePrompt" }).catch(() => {}); } catch { /* extension reloaded */ } // leaves the quick tab on the edge
        remove();
    });

    window.__finsPromptInstance = {
        update(next) { const { update, ...rest } = next || {}; current = update ? { ...current, ...rest } : rest; render(); if (!update) { setStatus("", ""); busy(false); } },
    };
    render();
    requestAnimationFrame(() => root.classList.add("fins-show"));
})();
