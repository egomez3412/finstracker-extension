/* extension/content/prompt.js — floating "sync now" prompt injected by
 * background.js when the user lands on a known issuer portal and has a
 * matching card. Idempotent: re-injection re-uses the existing widget.
 */

(function () {
    // Hard dedupe: if an instance exists in memory OR a prompt root is
    // already in the DOM (e.g. another frame injected it, or this script
    // got executed twice from background), just update payload and bail.
    if (window.__finsPromptInstance) {
        try { window.__finsPromptInstance.update(window.__finsPromptPayload); } catch (_) {}
        return;
    }
    if (document.getElementById("fins-prompt-root")) {
        return;
    }

    const payload = window.__finsPromptPayload || {};
    const host = document.createElement("div");
    host.id = "fins-prompt-root";
    host.setAttribute("data-fins-prompt", "");
    host.innerHTML = `
        <div class="fins-prompt" role="dialog" aria-label="Finstracker sync">
            <div class="fins-prompt-head">
                <span class="fins-prompt-mark" aria-hidden="true">
                    <img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="22" height="22">
                </span>
                <span class="fins-prompt-title">Finstracker</span>
                <button class="fins-prompt-close" type="button" aria-label="Dismiss">&times;</button>
            </div>
            <p class="fins-prompt-body"></p>
            <div class="fins-prompt-actions">
                <button class="fins-prompt-btn fins-prompt-btn-primary" type="button" data-act="sync">Sync now</button>
                <button class="fins-prompt-btn fins-prompt-btn-secondary" type="button" data-act="pick">Pick element</button>
            </div>
            <p class="fins-prompt-status" aria-live="polite"></p>
        </div>
    `;
    document.documentElement.appendChild(host);
    const root = host.firstElementChild;
    const body = root.querySelector(".fins-prompt-body");
    const status = root.querySelector(".fins-prompt-status");
    const syncBtn = root.querySelector("[data-act='sync']");
    const pickBtn = root.querySelector("[data-act='pick']");
    const closeBtn = root.querySelector(".fins-prompt-close");

    let current = payload;

    function setBody(p) {
        const name = p.cardName ? `<strong>${escape(p.cardName)}</strong>` : "your card";
        const issuer = p.issuer ? ` (${escape(p.issuer)})` : "";
        body.innerHTML = `Looks like you're on the ${escape(p.issuer || "issuer")} portal. Sync ${name}${issuer ? "" : ""} to Fins?`;
    }
    function escape(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    function setStatus(text, kind) {
        status.className = "fins-prompt-status" + (kind ? " is-" + kind : "");
        status.innerHTML = (kind === "syncing"
            ? '<span class="fins-prompt-spinner" aria-hidden="true"></span>'
            : "") + (text ? `<span>${escape(text)}</span>` : "");
    }

    function show() {
        requestAnimationFrame(() => root.classList.add("fins-show"));
    }
    function hide() {
        root.classList.remove("fins-show");
        setTimeout(() => host.remove(), 280);
        window.__finsPromptInstance = null;
        window.__finsPromptPayload = null;
    }

    syncBtn.addEventListener("click", async () => {
        if (!current?.cardId) return;
        syncBtn.disabled = true;
        pickBtn.disabled = true;
        setStatus("Reading this page\u2026", "syncing");
        try {
            const r = await chrome.runtime.sendMessage({
                type: "syncFromActiveTab",
                card: { id: current.cardId, issuer: current.issuer, displayName: current.cardName, rewardType: current.rewardType },
                tabId: null, // background uses sender.tab when null
            });
            if (!r?.ok) {
                setStatus(r?.error || "Sync failed", "error");
                syncBtn.disabled = false;
                pickBtn.disabled = false;
                return;
            }
            if (r.noop) {
                setStatus(`Already at ${Number(r.target).toLocaleString()}`, "success");
            } else {
                setStatus(`${Number(r.current).toLocaleString()} \u2192 ${Number(r.target).toLocaleString()}`, "success");
            }
            setTimeout(hide, 2500);
        } catch (err) {
            setStatus(err?.message || "Sync failed", "error");
            syncBtn.disabled = false;
            pickBtn.disabled = false;
        }
    });

    pickBtn.addEventListener("click", async () => {
        if (!current?.cardId) return;
        setStatus("Opening picker\u2026", "syncing");
        try {
            const r = await chrome.runtime.sendMessage({
                type: "startPickerForCard",
                card: { id: current.cardId, issuer: current.issuer, displayName: current.cardName, rewardType: current.rewardType },
            });
            if (!r?.ok) {
                setStatus(r?.error || "Could not open picker", "error");
                return;
            }
            hide();
        } catch (err) {
            setStatus(err?.message || "Could not open picker", "error");
        }
    });

    closeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "dismissPromptForOrigin", origin: location.origin }).catch(() => {});
        hide();
    });

    window.__finsPromptInstance = {
        update(p) {
            current = p || current;
            setBody(current);
            setStatus("", "");
            syncBtn.disabled = false;
            pickBtn.disabled = false;
        },
    };

    setBody(current);
    show();
})();
