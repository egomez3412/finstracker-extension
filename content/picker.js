/* Finstracker balance picker: a guided, two-step way to point at a card's balance.
 *   Step 1: suggestions (the likeliest numbers, numbered on the page) or click any number.
 *           Hovering shows the number that would be picked.
 *   Step 2: "Use 98,765 for Sapphire Preferred?" → Use it / Pick again.
 * Injected into every frame (isolated world) with window.__finsPickerPayload =
 * { cardName, unit, hints, canNavigate }. The guide lives in the top frame; in other frames a click
 * is the pick. Messages: pickerResult { selector, text, url }, cancelCapture, pickerNavigate.
 *
 * Banking pages often stop clicks at the document, so listeners sit on window in capture phase.
 * The guide is in a closed shadow root so page styles and scripts cannot reach it. */
(function () {
    if (window.__finsPickerActive) return;
    window.__finsPickerActive = true;
    const payload = window.__finsPickerPayload || {};
    const cardName = payload.cardName || "card";
    const isTop = window.top === window.self;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const send = (msg) => { try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch { /* extension reloaded */ } };

    function textOf(el) { return el ? (el.innerText || el.textContent || "").replace(/[    ]/g, " ").trim() : ""; }
    function firstNumber(text) {
        const m = String(text || "").match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
        if (!m) return null;
        const n = Number(m[0].replace(/,/g, ""));
        return Number.isFinite(n) ? { raw: m[0], n } : null;
    }
    // The smallest element around the click that holds a number (clicking a label works too).
    function numberElement(el) {
        let cur = el;
        for (let d = 0; d < 5 && cur && cur.nodeType === 1; d++) {
            const t = textOf(cur);
            if (t.length <= 60 && firstNumber(t)) return cur;
            cur = cur.parentElement;
        }
        return null;
    }
    // A precise path to the element; ignores our own classes.
    function cssPath(el) {
        const attr = (node) => {
            if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) return `#${CSS.escape(node.id)}`;
            for (const name of ["data-testid", "data-pt-name", "data-cy"]) {
                const v = node.getAttribute && node.getAttribute(name);
                if (v) return `[${name}="${CSS.escape(v)}"]`;
            }
            return null;
        };
        const parts = [];
        let cur = el;
        for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
            const own = attr(cur);
            if (own) { parts.unshift(own); break; }
            let seg = cur.tagName.toLowerCase();
            const cls = typeof cur.className === "string" ? cur.className.trim().split(/\s+/).filter((c) => c && c.length < 40 && !/^\d/.test(c) && !/\d{3,}/.test(c) && !/^fins-/.test(c)).slice(0, 2) : [];
            if (cls.length) seg += "." + cls.map((c) => CSS.escape(c)).join(".");
            const parent = cur.parentElement;
            if (parent) {
                const same = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
                if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
            }
            parts.unshift(seg);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            cur = parent;
        }
        return parts.join(" > ");
    }

    let host = null, shadow = null, hud = null, tag = null;
    let hoverEl = null, chosenEl = null, step = 1, message = "", lastPointerDown = 0;
    let suggestions = [];
    let observer = null;
    const marks = [];

    function refreshSuggestions() {
        let next = [];
        try { next = window.__finsReader?.suggestions(payload.unit || "points", payload.hints || null, 3) || []; } catch { next = []; }
        const same = next.length === suggestions.length && next.every((n, i) => n.el === suggestions[i].el);
        if (same && hud?.innerHTML) return;
        clearMarks();
        suggestions = next;
        showMarks();
        render();
    }

    // ---- page decorations: hover outline, chosen outline, numbered suggestion badges ----
    function outline(el, kind) {
        if (!el) return;
        el.classList.add(kind === "chosen" ? "fins-picker-locked" : "fins-picker-hover");
    }
    function unoutline(el) { el?.classList.remove("fins-picker-hover", "fins-picker-locked"); }
    function placeMarks() {
        for (const m of marks) {
            if (!m.el.isConnected) { m.badge.style.display = "none"; continue; }
            const r = m.el.getBoundingClientRect();
            Object.assign(m.badge.style, { display: "grid", left: `${Math.max(2, r.left - 12)}px`, top: `${Math.max(2, r.top - 12)}px` });
        }
    }
    function showMarks() {
        suggestions.forEach((s, i) => {
            const badge = document.createElement("div");
            badge.className = "fins-picker-badge";
            badge.textContent = String(i + 1);
            document.documentElement.appendChild(badge);
            s.el.classList.add("fins-picker-suggested");
            marks.push({ el: s.el, badge });
        });
        placeMarks();
    }
    function clearMarks() {
        for (const m of marks) { m.badge.remove(); m.el.classList.remove("fins-picker-suggested"); }
        marks.length = 0;
    }

    // ---- the guide (top frame) ----
    function render() {
        if (!hud) return;
        const n = chosenEl ? firstNumber(textOf(chosenEl)) : null;
        hud.innerHTML = `
            <div class="head"><img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="18" height="18"><span>Finstracker</span><button type="button" class="x" data-act="cancel" aria-label="Cancel">×</button></div>
            <div class="step">Step ${step} of 2</div>
            ${step === 1 ? `
                <div class="title">Click your ${esc(cardName)} balance</div>
                ${suggestions.length ? `<div class="sub">Is it one of these?</div><div class="list">${suggestions.map((s, i) => `<button type="button" class="sugg" data-act="suggest" data-i="${i}"><b>${i + 1}</b><span class="num">${esc(s.text)}</span><span class="lbl">${esc(s.label)}</span></button>`).join("")}</div>` : `<div class="sub">Point at the number on the page and click it.</div>`}
                ${message ? `<div class="msg">${esc(message)}</div>` : ""}
                <div class="row">${payload.canNavigate ? '<button type="button" data-act="navigate">Not on this page</button>' : ""}<button type="button" data-act="cancel">Cancel</button></div>
            ` : `
                <div class="title">Use ${esc(n?.raw || "")} for ${esc(cardName)}?</div>
                <div class="sub">It's outlined in green on the page.</div>
                <div class="row"><button type="button" class="primary" data-act="use">Use ${esc(n?.raw || "")}</button><button type="button" data-act="again">Pick again</button></div>
            `}`;
    }

    function choose(el) {
        const target = numberElement(el);
        if (!target) {
            message = "That spot has no number. Click the balance itself.";
            render();
            return;
        }
        if (!isTop) { finish(target); return; } // other frames: no guide to confirm in
        unoutline(chosenEl);
        chosenEl = target;
        unoutline(hoverEl);
        outline(chosenEl, "chosen");
        step = 2;
        message = "";
        hideTag();
        render();
    }

    function finish(el) {
        const selector = cssPath(el);
        const text = textOf(el);
        let url = location.href;
        try { url = window.top.location.href; } catch { /* cross-origin frame */ }
        cleanup();
        send({ type: "pickerResult", selector, text, url });
    }

    function onHudAction(act, data) {
        if (act === "cancel") { send({ type: "cancelCapture" }); cleanup(); }
        else if (act === "suggest") choose(suggestions[Number(data.i)]?.el);
        else if (act === "use" && chosenEl) finish(chosenEl);
        else if (act === "again") { unoutline(chosenEl); chosenEl = null; step = 1; render(); }
        else if (act === "navigate") { send({ type: "pickerNavigate" }); cleanup(); }
    }

    // ---- hover tag that follows the pointer ----
    function showTag(x, y, text, ok) {
        if (!tag) return;
        tag.textContent = text;
        tag.className = ok ? "tag" : "tag no";
        Object.assign(tag.style, { display: "block", left: `${Math.min(x + 14, innerWidth - 220)}px`, top: `${Math.min(y + 16, innerHeight - 40)}px` });
    }
    function hideTag() { if (tag) tag.style.display = "none"; }

    const inGuide = (e) => host && e.composedPath && e.composedPath().includes(host);
    const isOurs = (el) => el && el.closest && (el.closest("#fins-picker-host") || el.classList?.contains("fins-picker-badge") || el.closest("#fins-status-root"));

    function onMove(e) {
        if (step !== 1 || inGuide(e)) { hideTag(); return; }
        const el = e.target;
        if (!(el instanceof Element) || isOurs(el)) return;
        const target = numberElement(el);
        if (hoverEl !== (target || el)) { unoutline(hoverEl); hoverEl = target || el; if (hoverEl !== chosenEl) outline(hoverEl, "hover"); }
        const n = target ? firstNumber(textOf(target)) : null;
        showTag(e.clientX, e.clientY, n ? `${n.raw} · click to pick` : "No number here", Boolean(n));
    }
    function onDown(e) {
        if (inGuide(e)) return; // the guide's own buttons
        const el = e.target;
        if (!(el instanceof Element) || isOurs(el)) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        // Act on the pointer press; cancelling it stops the mouse events that would follow, so
        // mousedown only counts when no pointer event came first.
        if (e.type === "pointerdown") lastPointerDown = Date.now();
        else if (Date.now() - lastPointerDown < 600) return;
        if (step === 1) choose(el);
    }
    function swallow(e) {
        if (inGuide(e) || isOurs(e.target)) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); if (step === 2) onHudAction("again", {}); else onHudAction("cancel", {}); }
        else if (e.key === "Enter" && step === 2 && chosenEl) { e.preventDefault(); finish(chosenEl); }
        else if (step === 1 && /^[1-3]$/.test(e.key) && suggestions[Number(e.key) - 1]) { e.preventDefault(); choose(suggestions[Number(e.key) - 1].el); }
    }

    function cleanup() {
        window.__finsPickerActive = false;
        window.__finsPickerCleanup = null;
        for (const [type, fn] of [["mousemove", onMove], ["mousedown", onDown], ["pointerdown", onDown], ["click", swallow], ["mouseup", swallow], ["keydown", onKey]]) window.removeEventListener(type, fn, true);
        window.removeEventListener("scroll", placeMarks, true);
        observer?.disconnect();
        observer = null;
        unoutline(hoverEl); unoutline(chosenEl); clearMarks();
        document.querySelectorAll(".fins-picker-hover, .fins-picker-locked, .fins-picker-suggested").forEach((n) => n.classList.remove("fins-picker-hover", "fins-picker-locked", "fins-picker-suggested"));
        document.querySelectorAll("#fins-picker-host, .fins-picker-badge").forEach((n) => n.remove());
        document.documentElement.classList.remove("fins-picker-on");
        host = shadow = hud = tag = hoverEl = chosenEl = null;
    }

    // ---- start ----
    document.documentElement.classList.add("fins-picker-on");
    if (isTop) {
        host = document.createElement("div");
        host.id = "fins-picker-host";
        Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" });
        document.documentElement.appendChild(host);
        shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = `<style>
            :host, * { box-sizing: border-box; }
            .hud { position: fixed; left: 16px; bottom: 16px; width: 340px; max-width: calc(100vw - 32px); padding: 14px 16px; border-radius: 12px; background: #fff; color: #1a1f17; font: 400 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 12px 32px rgba(26,31,23,.16), 0 2px 6px rgba(26,31,23,.08); pointer-events: auto; }
            .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 14px; font-weight: 500; }
            .head span { flex: 1; }
            .head img { border-radius: 4px; }
            .x { all: unset; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: #4f5648; font-size: 18px; cursor: pointer; }
            .x:hover { background: #f3f4f0; }
            .step { font-size: 10px; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; color: #4f5648; }
            .title { margin: 2px 0 4px; font-size: 16px; font-weight: 600; }
            .sub { color: #4f5648; font-size: 12px; margin-bottom: 8px; }
            .list { display: grid; gap: 6px; margin-bottom: 8px; }
            .sugg { all: unset; display: grid; grid-template-columns: 22px auto 1fr; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #e5e8e1; border-radius: 8px; cursor: pointer; }
            .sugg:hover, .sugg:focus-visible { border-color: #1d6b4a; background: #e9f6ef; }
            .sugg b { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #1d6b4a; color: #fff; font-size: 11px; }
            .sugg .num { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
            .sugg .lbl { overflow: hidden; color: #4f5648; font-size: 12px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
            .msg { margin: 0 0 8px; color: #a32424; font-size: 12px; }
            .row { display: flex; gap: 6px; flex-wrap: wrap; }
            .row button { all: unset; display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border: 1px solid #e5e8e1; border-radius: 8px; background: #fff; color: #1a1f17; font-size: 13px; font-weight: 500; cursor: pointer; }
            .row button:hover { border-color: #c4bba6; }
            .row button.primary { background: #1d6b4a; border-color: #1d6b4a; color: #fff; }
            .row button.primary:hover { background: #144f37; }
            button:focus-visible { outline: 2px solid #087487; outline-offset: 2px; }
            .tag { position: fixed; display: none; padding: 4px 8px; border-radius: 999px; background: #1d6b4a; color: #fff; font: 500 12px/1.4 system-ui, sans-serif; pointer-events: none; white-space: nowrap; }
            .tag.no { background: #4f5648; }
            @media (prefers-color-scheme: dark) {
                .hud { background: #222a26; color: #eef4ee; }
                .sub, .step, .sugg .lbl, .x { color: #aebcb2; }
                .sugg, .row button { border-color: #3c4940; background: #2c3530; color: #eef4ee; }
                .sugg:hover { background: #213a2e; }
                .msg { color: #f08a8a; }
            }
        </style><div class="hud" role="dialog" aria-label="Pick your balance"></div><div class="tag"></div>`;
        hud = shadow.querySelector(".hud");
        tag = shadow.querySelector(".tag");
        hud.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-act]");
            if (btn) { e.preventDefault(); onHudAction(btn.dataset.act, btn.dataset); }
        });
        refreshSuggestions();
        hud.querySelector(".sugg")?.focus({ preventScroll: true });
        // Bank pages fill in after they load: refresh the suggestions as content arrives.
        let timer = 0;
        observer = new MutationObserver((records) => {
            if (step !== 1 || records.every((r) => isOurs(r.target instanceof Element ? r.target : r.target.parentElement))) return;
            clearTimeout(timer);
            timer = setTimeout(refreshSuggestions, 500);
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    window.__finsPickerCleanup = cleanup;
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("click", swallow, true);
    window.addEventListener("mouseup", swallow, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", placeMarks, true);
})();
