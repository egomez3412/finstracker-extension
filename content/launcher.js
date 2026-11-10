/* Finstracker quick tab: a small tab on the edge of a card's site that opens a menu of quick
 * actions (sync balance, pick it, offers, benefits, autopilot, open the side panel). It appears
 * when the sync prompt is closed. Drag it along the left or right edge; it snaps to the nearer
 * side and remembers where it was (chrome.storage.local "launcherPos").
 * Payload: window.__finsLauncherPayload = { cards: [{ id, displayName, issuer, cardKey, program, rewardType }] }. */
(function () {
    const payload = window.__finsLauncherPayload || {};
    if (window.__finsLauncher) { window.__finsLauncher.update(payload); return; }
    if (window.top !== window.self) return;

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    let cards = payload.cards || [];
    let currentId = payload.current || null; // the card the page shows
    let pos = { side: "right", top: 0.62 };
    let open = false;
    let message = "";

    const host = document.createElement("div");
    host.id = "fins-launcher-root";
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "2147483645", pointerEvents: "none" });
    document.documentElement.appendChild(host);
    // Some sites redraw the whole page and drop anything added to it: put this back until it's closed.
    const keep = new MutationObserver(() => { if (!host.isConnected) document.documentElement.appendChild(host); });
    keep.observe(document.documentElement, { childList: true });
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
        :host, * { box-sizing: border-box; }
        .tab { position: fixed; display: grid; place-items: center; width: 40px; height: 46px; background: #fff; box-shadow: 0 2px 10px rgba(26,31,23,.18); cursor: grab; pointer-events: auto; touch-action: none; transition: width .15s ease, box-shadow .15s ease; user-select: none; }
        .tab.right { right: 0; border-radius: 12px 0 0 12px; }
        .tab.left { left: 0; border-radius: 0 12px 12px 0; }
        .tab:hover, .tab:focus-visible { width: 46px; box-shadow: 0 4px 14px rgba(26,31,23,.24); }
        .tab.dragging { cursor: grabbing; transition: none; box-shadow: 0 8px 22px rgba(26,31,23,.28); }
        .tab img { width: 22px; height: 22px; pointer-events: none; }
        .tab:focus-visible { outline: 2px solid #087487; outline-offset: 2px; }
        .menu { position: fixed; width: 260px; padding: 12px; border-radius: 12px; background: #fff; color: #1a1f17; font: 400 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 12px 32px rgba(26,31,23,.16), 0 2px 6px rgba(26,31,23,.08); pointer-events: auto; }
        .menu[hidden] { display: none; }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 14px; font-weight: 500; }
        .head span { flex: 1; }
        .x { all: unset; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: #4f5648; font-size: 18px; cursor: pointer; }
        .x:hover { background: #f3f4f0; }
        select { width: 100%; height: 32px; margin-bottom: 8px; padding: 0 8px; border: 1px solid #e5e8e1; border-radius: 8px; background: #fff; color: #1a1f17; font: inherit; }
        .item { all: unset; display: flex; align-items: center; justify-content: space-between; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; }
        .item:hover, .item:focus-visible { background: #f3f4f0; }
        .item.primary { background: #1d6b4a; color: #fff; margin-bottom: 4px; }
        .item.primary:hover { background: #144f37; }
        .item small { color: #4f5648; font-weight: 400; }
        .item.primary small { color: #dff5f7; }
        .sep { height: 1px; margin: 6px 0; background: #f0e9da; }
        .msg { margin: 6px 2px 0; color: #4f5648; font-size: 12px; }
        .muted { color: #4f5648; }
        @media (prefers-color-scheme: dark) {
            .tab, .menu { background: #222a26; color: #eef4ee; }
            select { background: #2c3530; border-color: #3c4940; color: #eef4ee; }
            .item:hover { background: #2c3530; }
            .item small, .msg, .muted, .x { color: #aebcb2; }
            .sep { background: #3c4940; }
        }
    </style>
    <div class="tab right" role="button" tabindex="0" aria-label="Finstracker quick actions" title="Finstracker · drag to move"><img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt=""></div>
    <div class="menu" role="dialog" aria-label="Finstracker" hidden></div>`;
    const tab = shadow.querySelector(".tab");
    const menu = shadow.querySelector(".menu");

    const selectedCard = () => cards.find((c) => c.id === menu.querySelector("select")?.value) || cards.find((c) => c.id === currentId) || cards[0] || null;

    function place() {
        const y = Math.min(Math.max(pos.top * innerHeight, 8), innerHeight - 54);
        tab.className = `tab ${pos.side}`;
        tab.style.top = `${y}px`;
        menu.style.top = `${Math.min(Math.max(y - 12, 8), Math.max(8, innerHeight - menu.offsetHeight - 8))}px`;
        menu.style.left = pos.side === "left" ? "54px" : "";
        menu.style.right = pos.side === "right" ? "54px" : "";
    }

    function render() {
        const card = selectedCard();
        const unit = card?.rewardType === "cashback" ? "cash back" : "points";
        menu.innerHTML = `
            <div class="head"><img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="18" height="18"><span>Finstracker</span><button type="button" class="x" data-act="close" aria-label="Close">×</button></div>
            ${cards.length > 1 ? `<select aria-label="Card">${cards.map((c) => `<option value="${esc(c.id)}"${c.id === card?.id ? " selected" : ""}>${esc(c.displayName)}${c.id === currentId ? " (on screen)" : ""}</option>`).join("")}</select>` : card ? `<div class="muted" style="margin:0 2px 8px">${esc(card.displayName)}</div>` : ""}
            ${card ? `
                <button type="button" class="item primary" data-act="sync">Sync ${unit} <small>from this page</small></button>
                <button type="button" class="item" data-act="pick">Pick the balance</button>
                <button type="button" class="item" data-act="offers">Sync offers <small>adds them to the card</small></button>
                <button type="button" class="item" data-act="benefits">Sync benefits</button>
                <button type="button" class="item" data-act="autopilot">Run autopilot <small>${cards.length > 1 ? "this card" : ""}</small></button>
                ${cards.length > 1 ? `<button type="button" class="item" data-act="autopilot-all">Run autopilot for all ${cards.length} <small>cards on this site</small></button>` : ""}
                <div class="sep"></div>` : ""}
            <button type="button" class="item" data-act="panel">Open Finstracker</button>
            <button type="button" class="item" data-act="hide">Hide on this site</button>
            ${message ? `<p class="msg" role="status">${esc(message)}</p>` : ""}`;
        place();
    }

    function toggle(on = !open) {
        open = on;
        menu.hidden = !open;
        if (open) { render(); menu.querySelector("button.item")?.focus({ preventScroll: true }); }
    }

    async function act(name) {
        const card = selectedCard();
        const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err?.message })); } catch (err) { return Promise.resolve({ ok: false, error: "Finstracker was updated. Reload this page." }); } };
        if (name === "close") return toggle(false);
        if (name === "hide") {
            const { launcherHidden = {} } = await chrome.storage.local.get("launcherHidden");
            await chrome.storage.local.set({ launcherHidden: { ...launcherHidden, [location.origin]: true } });
            return remove();
        }
        if (name === "panel") { await send({ type: "openSidePanel" }); return toggle(false); }
        if (!card) return;
        // Offers, benefits and autopilot take a while: the page's status note shows their progress.
        if (name === "autopilot-all") {
            send({ type: "runAutopilot", cardIds: cards.map((c) => c.id), here: true, current: currentId });
            return toggle(false);
        }
        if (name === "offers" || name === "benefits" || name === "autopilot") {
            send(name === "offers" ? { type: "syncOffers", card } : name === "benefits" ? { type: "syncBenefits", card } : { type: "runAutopilot", cardIds: [card.id], here: true });
            return toggle(false);
        }
        message = "Working on it…";
        render();
        const result = name === "sync" ? await send({ type: "syncFromActiveTab", card, tabId: null }) : await send({ type: "startPickerForCard", card });
        message = result?.ok === false ? result.error || "Something went wrong" : "";
        if (result?.ok !== false) toggle(false); else render();
    }

    menu.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (btn) act(btn.dataset.act);
    });
    menu.addEventListener("change", () => render());
    tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        if (e.key === "Escape") toggle(false);
    });

    // Drag along the edges; a press without movement is a click.
    let drag = null;
    tab.addEventListener("pointerdown", (e) => {
        drag = { x: e.clientX, y: e.clientY, moved: false };
        tab.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    tab.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
        drag.moved = true;
        tab.classList.add("dragging");
        pos = { side: e.clientX < innerWidth / 2 ? "left" : "right", top: Math.min(Math.max(e.clientY - 23, 8), innerHeight - 54) / innerHeight };
        place();
    });
    tab.addEventListener("pointerup", (e) => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        tab.classList.remove("dragging");
        try { tab.releasePointerCapture(e.pointerId); } catch { /* released */ }
        if (moved) chrome.storage.local.set({ launcherPos: pos }).catch(() => {});
        else toggle();
    });
    addEventListener("resize", place);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) toggle(false); });

    function remove() {
        keep.disconnect();
        host.remove();
        window.__finsLauncher = null;
    }

    window.__finsLauncher = {
        update(next) { cards = next?.cards || cards; currentId = next?.current ?? currentId; if (open) render(); },
        remove,
    };
    chrome.storage.local.get("launcherPos").then(({ launcherPos }) => {
        if (launcherPos && (launcherPos.side === "left" || launcherPos.side === "right")) pos = launcherPos;
        place();
    }).catch(() => place());
    place();
})();
