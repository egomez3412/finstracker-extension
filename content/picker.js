// extension/content/picker.js — injected into a portal tab (all frames) when
// the user clicks "Pick element manually". Highlights elements on hover and
// shows a live preview of the element's text plus any detected number; on
// click, walks up to the smallest ancestor that actually contains a number
// (so users can click the value or its label without thinking), computes a
// stable CSS selector and ships it back to the service worker.
//
// Why this is built the way it is:
//   - Banking SPAs (Chase especially) attach aggressive capture-phase click
//     handlers on `document` that stopImmediatePropagation. To beat them
//     reliably we attach our listeners to `window` in capture phase — those
//     fire BEFORE any document-level handler regardless of registration
//     order.
//   - The HUD lives inside a closed shadow root so the host page can't
//     restyle it, can't intercept its events, and our buttons remain
//     clickable even if the page sets `pointer-events: none` on body.

(function () {
    if (window.__finsPickerActive) return;
    window.__finsPickerActive = true;

    let lastHover = null;
    let lastChosen = null;
    let locked = false;
    let lockedEl = null;

    function pickText(el) {
        if (!el) return "";
        return (el.innerText || el.textContent || "").trim();
    }

    function firstNumber(text) {
        if (!text) return null;
        const m = String(text).match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
        if (!m) return null;
        const n = Number(m[0].replace(/,/g, ""));
        return Number.isFinite(n) ? { raw: m[0], n } : null;
    }

    function smartChoose(el) {
        let cur = el;
        for (let d = 0; d < 5 && cur; d++) {
            if (firstNumber(pickText(cur))) return cur;
            cur = cur.parentElement;
        }
        return el;
    }

    function cssPath(el) {
        if (!(el instanceof Element)) return null;
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
        const testId = el.getAttribute("data-testid");
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const ptName = el.getAttribute("data-pt-name");
        if (ptName) return `[data-pt-name="${CSS.escape(ptName)}"]`;
        const dataCy = el.getAttribute("data-cy");
        if (dataCy) return `[data-cy="${CSS.escape(dataCy)}"]`;
        const label = el.getAttribute("aria-label");
        if (label && label.length < 80) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(label)}"]`;

        const parts = [];
        let cur = el;
        for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
            let seg = cur.tagName.toLowerCase();
            const cls = (cur.className && typeof cur.className === "string")
                ? cur.className.trim().split(/\s+/)
                    .filter((c) => c && c.length < 40 && !/^\d/.test(c) && !/\d{3,}/.test(c))
                    .slice(0, 2)
                : [];
            if (cls.length) seg += "." + cls.map((c) => CSS.escape(c)).join(".");
            const parent = cur.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
                if (sameTag.length > 1) {
                    const idx = sameTag.indexOf(cur) + 1;
                    seg += `:nth-of-type(${idx})`;
                }
            }
            parts.unshift(seg);
            if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
                parts[0] = `#${CSS.escape(cur.id)}`;
                break;
            }
            cur = cur.parentElement;
        }
        return parts.join(" > ");
    }

    const isTop = window.top === window.self;
    let host = null;
    let shadow = null;
    let previewEl = null;
    let confirmBtn = null;
    let cancelBtn = null;
    let pickAgainBtn = null;
    let statusEl = null;
    let dotEl = null;

    if (isTop) {
        host = document.createElement("div");
        host.id = "fins-picker-host";
        host.style.position = "fixed";
        host.style.zIndex = "2147483647";
        host.style.top = "0";
        host.style.left = "0";
        host.style.width = "0";
        host.style.height = "0";
        host.style.pointerEvents = "none";
        (document.body || document.documentElement).appendChild(host);
        shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = `
            <style>
                :host, * { box-sizing: border-box; }
                .hud {
                    position: fixed; top: 12px; left: 12px;
                    max-width: 420px; min-width: 320px;
                    background: #ffffff; color: #1a1f17;
                    padding: 12px 14px;
                    border: 1px solid #e5e8e1;
                    border-left: 3px solid #1d6b4a;
                    border-radius: 10px;
                    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                    box-shadow: 0 8px 28px rgba(26, 31, 23, 0.16);
                    pointer-events: auto;
                }
                .hud b, .hud strong { color: #1d6b4a; }
                .row { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
                .status { margin-top: 6px; font-size: 11px; color: #4f5648; }
                button {
                    background: #ffffff; color: #1a1f17;
                    border: 1px solid #e5e8e1;
                    border-radius: 8px;
                    padding: 6px 12px;
                    cursor: pointer;
                    font: inherit; font-weight: 600;
                }
                button:hover { background: #f3f4f0; }
                button.primary { background: #1d6b4a; color: #ffffff; border-color: #1d6b4a; }
                button.primary:hover { background: #144f37; border-color: #144f37; }
                button:disabled { opacity: 0.55; cursor: not-allowed; }
                .preview {
                    margin-top: 8px; padding: 8px 10px;
                    background: #f7f7f4; border: 1px solid #e5e8e1;
                    border-radius: 6px; font-size: 12px;
                    max-height: 80px; overflow: hidden; word-break: break-word;
                }
                .preview .num { color: #1d6b4a; font-weight: 700; }
                .preview .empty { color: #4f5648; font-style: italic; }
                .title { display: flex; align-items: center; gap: 6px; }
                .dot { width: 8px; height: 8px; border-radius: 999px; background: #1d6b4a; display: inline-block; }
                .dot.green { background: #087487; }
            </style>
            <div class="hud" role="dialog" aria-label="Finstracker picker">
                <div class="title">
                    <span class="dot" id="finsDot"></span>
                    <strong>Finstracker</strong>
                    <span style="color:#4f5648;font-size:11px;">click the points value on this page</span>
                </div>
                <div class="preview" id="finsPreview"><span class="empty">Hover over the points value…</span></div>
                <div class="row">
                    <button type="button" class="primary" id="finsConfirm" disabled>Use this value</button>
                    <button type="button" id="finsPickAgain" hidden>Pick another</button>
                    <button type="button" id="finsCancel">Cancel</button>
                </div>
                <div class="status" id="finsStatus">Tip: press Esc to cancel, Enter to confirm.</div>
            </div>
        `;
        previewEl = shadow.getElementById("finsPreview");
        confirmBtn = shadow.getElementById("finsConfirm");
        cancelBtn = shadow.getElementById("finsCancel");
        pickAgainBtn = shadow.getElementById("finsPickAgain");
        statusEl = shadow.getElementById("finsStatus");
        dotEl = shadow.getElementById("finsDot");

        // Stop page-level event swallowing for anything inside the HUD.
        const hudRoot = shadow.querySelector(".hud");
        const stop = (e) => { e.stopPropagation(); };
        for (const evt of ["mousedown", "mouseup", "click", "pointerdown", "pointerup"]) {
            hudRoot.addEventListener(evt, stop, true);
        }

        cancelBtn.addEventListener("click", (e) => {
            console.log("[finstracker] cancel clicked");
            e.preventDefault();
            cancelPicker();
        });
        confirmBtn.addEventListener("click", (e) => {
            console.log("[finstracker] confirm clicked", { locked, hasLockedEl: !!lockedEl, hasLastChosen: !!lastChosen });
            e.preventDefault();
            const target = lockedEl || lastChosen;
            if (target) chooseElement(target);
            else cleanup(); // never leave the HUD up if nothing to send
        });
        pickAgainBtn.addEventListener("click", (e) => {
            e.preventDefault();
            unlock();
        });

        try { document.documentElement.classList.add("fins-picker-on"); } catch { /* noop */ }
    }

    function setStatus(text) { if (statusEl) statusEl.textContent = text || ""; }

    function lockOn(el) {
        locked = true;
        lockedEl = smartChoose(el);
        if (lastHover && lastHover !== lockedEl) lastHover.classList.remove("fins-picker-hover");
        if (lockedEl && lockedEl.classList) {
            lockedEl.classList.remove("fins-picker-hover");
            lockedEl.classList.add("fins-picker-locked");
        }
        lastHover = lockedEl;
        updatePreview(lockedEl, true);
        if (pickAgainBtn) pickAgainBtn.hidden = false;
        if (dotEl) dotEl.classList.add("green");
        setStatus("Locked. Press \"Use this value\" or pick another.");
    }

    function unlock() {
        if (lockedEl && lockedEl.classList) lockedEl.classList.remove("fins-picker-locked");
        locked = false;
        lockedEl = null;
        if (previewEl) previewEl.innerHTML = `<span class="empty">Hover over the points value…</span>`;
        if (confirmBtn) confirmBtn.disabled = true;
        if (pickAgainBtn) pickAgainBtn.hidden = true;
        if (dotEl) dotEl.classList.remove("green");
        setStatus("Tip: press Esc to cancel, Enter to confirm.");
    }

    function updatePreview(el, forceLocked) {
        if (!previewEl) return;
        if (locked && !forceLocked) return;
        const chosen = smartChoose(el);
        lastChosen = chosen;
        const txt = pickText(chosen).replace(/\s+/g, " ").slice(0, 200);
        const num = firstNumber(txt);
        if (!txt) {
            previewEl.innerHTML = `<span class="empty">No text in this element.</span>`;
            if (confirmBtn) confirmBtn.disabled = true;
            return;
        }
        const safe = txt.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c]));
        if (num) {
            const highlighted = safe.replace(num.raw, `<span class="num">${num.raw}</span>`);
            previewEl.innerHTML = `<b>${locked ? "Locked" : "Detected"}:</b> ${highlighted}`;
            if (confirmBtn) confirmBtn.disabled = false;
        } else {
            previewEl.innerHTML = `<b>No number found in:</b> ${safe}`;
            if (confirmBtn) confirmBtn.disabled = true;
        }
    }

    function chooseElement(el) {
        const chosen = smartChoose(el);
        const selector = cssPath(chosen);
        const text = pickText(chosen);
        let url = location.href;
        try { if (window.top && window.top.location && window.top.location.href) url = window.top.location.href; }
        catch { /* cross-origin iframe — fall back to our own URL */ }
        // Tear down the picker UI FIRST so the user gets immediate feedback,
        // then fire the message. We never want the picker to stay on screen
        // waiting for a background round-trip that might fail silently.
        cleanup();
        try {
            chrome.runtime.sendMessage(
                { type: "pickerResult", selector, text, url },
                () => { void chrome.runtime.lastError; /* swallow */ }
            );
        } catch { /* extension reloaded; nothing else to do */ }
    }

    function isInHud(el) {
        if (!host) return false;
        if (el === host) return true;
        if (el && el.closest && el.closest("#fins-picker-host")) return true;
        return false;
    }

    function onMove(e) {
        const el = e.composedPath ? e.composedPath()[0] : e.target;
        if (!el || isInHud(el)) return;
        if (locked) return;
        if (lastHover && lastHover !== el) lastHover.classList.remove("fins-picker-hover");
        lastHover = el;
        if (el && el.classList) el.classList.add("fins-picker-hover");
        if (isTop) updatePreview(el);
    }

    function suppress(e) {
        if (isInHud(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    function onPick(e) {
        // If the user is interacting with an HUD button, handle it here in
        // the earliest possible capture phase — banking SPAs install
        // window-capture click handlers that call stopImmediatePropagation,
        // which would otherwise prevent our shadow-DOM button handlers from
        // ever firing.
        const path = (e.composedPath && e.composedPath()) || [];
        for (const node of path) {
            if (!(node instanceof Element)) continue;
            const id = node.id;
            if (id === "finsConfirm" || id === "finsCancel" || id === "finsPickAgain") {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                // Only act on the first event of a logical click — pointerdown
                // fires before mousedown which fires before click. Use mousedown.
                if (e.type !== "mousedown") return;
                if (id === "finsConfirm") {
                    console.log("[finstracker] confirm via capture");
                    const target = lockedEl || lastChosen;
                    if (target) chooseElement(target);
                    else cleanup();
                } else if (id === "finsCancel") {
                    console.log("[finstracker] cancel via capture");
                    cancelPicker();
                } else if (id === "finsPickAgain") {
                    unlock();
                }
                return;
            }
            if (id === "fins-picker-host") {
                // Click landed on HUD but not on a button (e.g. preview area).
                // Don't treat as a page pick; let the shadow DOM handle it.
                return;
            }
        }
        if (isInHud(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        const el = path.find((n) => n instanceof Element && !isInHud(n)) || e.target;
        lockOn(el);
    }

    function onKey(e) {
        if (e.key === "Escape") {
            if (locked) unlock();
            else cancelPicker();
        } else if (e.key === "Enter") {
            const el = lockedEl || lastChosen;
            if (el) { e.preventDefault(); chooseElement(el); }
        }
    }

    // User-initiated cancel: tell the background to drop the capture
    // session so the side panel status clears.
    // Successful picks go through chooseElement -> pickerResult instead and
    // must NOT cancel, so cleanup() alone stays the no-signal teardown.
    function cancelPicker() {
        try {
            chrome.runtime.sendMessage(
                { type: "cancelCapture" },
                () => { void chrome.runtime.lastError; /* swallow */ }
            );
        } catch { /* extension reloaded; nothing else to do */ }
        cleanup();
    }

    function cleanup() {
        console.log("[finstracker] picker cleanup");
        try { window.__finsPickerActive = false; } catch { /* noop */ }
        for (const t of [window, document]) {
            try { t.removeEventListener("mousemove", onMove, true); } catch { /* noop */ }
            try { t.removeEventListener("mousedown", onPick, true); } catch { /* noop */ }
            try { t.removeEventListener("pointerdown", onPick, true); } catch { /* noop */ }
            try { t.removeEventListener("click", suppress, true); } catch { /* noop */ }
            try { t.removeEventListener("mouseup", suppress, true); } catch { /* noop */ }
            try { t.removeEventListener("keydown", onKey, true); } catch { /* noop */ }
        }
        try { if (lastHover) lastHover.classList.remove("fins-picker-hover"); } catch { /* noop */ }
        try { if (lockedEl) lockedEl.classList.remove("fins-picker-locked"); } catch { /* noop */ }
        // Belt-and-suspenders: nuke ALL picker decorations and any stale
        // host that an earlier (errored) invocation may have left behind.
        try {
            document.querySelectorAll(".fins-picker-hover").forEach((n) => n.classList.remove("fins-picker-hover"));
            document.querySelectorAll(".fins-picker-locked").forEach((n) => n.classList.remove("fins-picker-locked"));
            document.querySelectorAll("#fins-picker-host").forEach((n) => n.remove());
        } catch { /* noop */ }
        try { document.documentElement.classList.remove("fins-picker-on"); } catch { /* noop */ }
        host = null; shadow = null; previewEl = null;
        confirmBtn = null; cancelBtn = null; pickAgainBtn = null;
        statusEl = null; dotEl = null;
        lastHover = null; lockedEl = null; lastChosen = null;
        locked = false;
    }

    // Capture-phase on WINDOW so we run before any document-level handler
    // banking SPAs install — window capture is the very first phase.
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mousedown", onPick, true);
    window.addEventListener("pointerdown", onPick, true);
    window.addEventListener("click", suppress, true);
    window.addEventListener("mouseup", suppress, true);
    window.addEventListener("keydown", onKey, true);
})();
