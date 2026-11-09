/* Best card note on checkout pages. Injected only when the user turned on "Best card at checkout"
 * and granted site access. Payload: window.__finsCheckoutPayload = { merchant, category, best, next, offers }. */
(function () {
    const p = window.__finsCheckoutPayload;
    if (!p?.best) return;
    document.getElementById("fins-checkout-root")?.remove();

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const host = document.createElement("div");
    host.id = "fins-checkout-root";
    host.innerHTML = `
        <div class="fins-checkout" role="complementary" aria-label="Finstracker best card">
            <div class="fins-prompt-head">
                <img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="20" height="20">
                <span class="fins-prompt-title">Pay with ${esc(p.best.name)}</span>
                <button class="fins-prompt-close" type="button" aria-label="Close">×</button>
            </div>
            <div class="fins-checkout-rate"><strong>${esc(p.best.rate)}</strong><span>${esc(p.category)}${p.merchant ? ` at ${esc(p.merchant)}` : ""} · ${esc(p.best.cents)}¢ per $1</span></div>
            ${p.next ? `<div class="fins-checkout-next">Next best: ${esc(p.next.name)}, ${esc(p.next.rate)}</div>` : ""}
            ${(p.offers || []).map((o) => `<div class="fins-checkout-offer">${esc(o.title)}${o.cardName ? ` <span>· ${esc(o.cardName)}</span>` : ""}</div>`).join("")}
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
