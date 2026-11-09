/* Best card note on checkout pages. Injected only when the user turned on "Best card at checkout"
 * and granted site access. Payload: window.__finsCheckoutPayload = { merchant, category, best, next, offers }. */
(function () {
    const p = window.__finsCheckoutPayload;
    if (!p?.best) return;
    document.getElementById("fins-checkout-root")?.remove();

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const host = document.createElement("div");
    host.id = "fins-checkout-root";
    const rows = [
        ...(p.next ? [[`Next best: ${p.next.name}`, `${p.next.rate} · ${p.next.cents}¢`]] : []),
        ...(p.offers || []).map((o) => [o.title, o.cardName || ""]),
    ];
    host.innerHTML = `
        <div class="fins-checkout" role="complementary" aria-label="Finstracker best card">
            <div class="fins-prompt-head">
                <img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="20" height="20">
                <span class="fins-prompt-title">Finstracker</span>
                <button class="fins-prompt-close" type="button" aria-label="Close">×</button>
            </div>
            <div class="fins-checkout-kicker">Pay with</div>
            <div class="fins-checkout-card">${esc(p.best.name)}</div>
            <div class="fins-checkout-sub">${esc(p.best.rate)} · ${esc(p.category)}${p.merchant ? ` at ${esc(p.merchant)}` : ""} · ${esc(p.best.cents)}¢ per $1</div>
            ${rows.length ? `<dl class="fins-checkout-rows">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
        </div>`;
    document.documentElement.appendChild(host);
    const root = host.firstElementChild;
    root.querySelector(".fins-prompt-close").addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "dismissPromptForOrigin", origin: location.origin }).catch(() => {});
        root.classList.remove("fins-show");
        setTimeout(() => host.remove(), 260);
    });
    requestAnimationFrame(() => root.classList.add("fins-show"));
})();
