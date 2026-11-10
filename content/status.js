/* Finstracker status note on the page being synced: what the extension is doing, and the found
 * balance to confirm. Shown and updated by the service worker with window.__finsStatus.show(state);
 * buttons send { type: "statusAction", action } back. Uses the prompt.css card look. */
(function () {
    if (window.__finsStatus) return;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    let host = null, root = null, hideTimer = 0, keep = null;

    function mount() {
        if (host?.isConnected) return;
        keep?.disconnect();
        host?.remove();
        host = document.createElement("div");
        host.id = "fins-status-root";
        host.innerHTML = '<div class="fins-prompt fins-status" role="status" aria-live="polite"></div>';
        document.documentElement.appendChild(host);
        // Some sites redraw the whole page: put the note back until it's hidden.
        keep = new MutationObserver(() => { if (host && !host.isConnected) document.documentElement.appendChild(host); });
        keep.observe(document.documentElement, { childList: true });
        root = host.firstElementChild;
        root.addEventListener("click", (event) => {
            const btn = event.target.closest("[data-action]");
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === "close") hide();
            try { chrome.runtime.sendMessage({ type: "statusAction", action }).catch(() => {}); } catch { /* extension reloaded */ }
        });
        requestAnimationFrame(() => root.classList.add("fins-show"));
    }

    function hide() {
        clearTimeout(hideTimer);
        keep?.disconnect();
        keep = null;
        if (!root) return;
        root.classList.remove("fins-show");
        const old = host;
        setTimeout(() => old?.remove(), 260);
        host = root = null;
    }

    /** state: { kind: "busy"|"ask"|"ok"|"error", title, text, value, actions: [[action, label, primary]], autoHide } */
    function show(state) {
        clearTimeout(hideTimer);
        mount();
        const busy = state.kind === "busy";
        root.innerHTML = `
            <div class="fins-prompt-head">
                <img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="20" height="20">
                <span class="fins-prompt-title">Finstracker</span>
                <button class="fins-prompt-close" type="button" aria-label="Close" data-action="close">×</button>
            </div>
            <div class="fins-status-line">${busy ? '<span class="fins-prompt-spinner" aria-hidden="true"></span>' : ""}<strong>${esc(state.title)}</strong></div>
            ${state.value != null ? `<div class="fins-status-value is-${esc(state.kind)}">${esc(state.value)}</div>` : ""}
            ${state.text ? `<p class="fins-prompt-body">${esc(state.text)}</p>` : ""}
            ${state.rows?.length ? `<dl class="fins-status-rows">${state.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
            ${state.actions?.length ? `<div class="fins-prompt-actions">${state.actions.map(([action, label, primary]) => `<button type="button" class="fins-prompt-btn${primary ? " fins-prompt-primary" : ""}" data-action="${esc(action)}">${esc(label)}</button>`).join("")}</div>` : ""}`;
        if (state.autoHide) hideTimer = setTimeout(hide, state.autoHide);
    }

    window.__finsStatus = { show, hide };
})();
