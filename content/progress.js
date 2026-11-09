/* Finstracker autopilot board, on the portal page where autopilot was started: one block per card
 * with its activities (balance, offers, benefits) and where each one stands. Offers and benefits run
 * in their own windows at the same time; this board shows all of it in one place.
 * Shown and updated with window.__finsBoard.show(board); buttons send { type: "stopAutopilot" }.
 * board: { running, title, cards: [{ name, current, steps: [{ name, state, text }] }] }
 *   state: "waiting" | "busy" | "done" | "error" | "skipped" */
(function () {
    if (window.__finsBoard) return;
    if (window.top !== window.self) return;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    let host = null, root = null, collapsed = false, last = null;

    function mount() {
        if (host?.isConnected) return;
        host = document.createElement("div");
        host.id = "fins-board-root";
        Object.assign(host.style, { position: "fixed", top: "16px", right: "16px", zIndex: "2147483646" });
        const shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = `<style>
            :host, * { box-sizing: border-box; }
            .board { width: 330px; max-height: calc(100vh - 32px); overflow: auto; padding: 14px 16px; border-radius: 12px; background: #fff; color: #1a1f17; font: 400 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 12px 32px rgba(26,31,23,.16), 0 2px 6px rgba(26,31,23,.08); }
            .head { display: flex; align-items: center; gap: 8px; }
            .head img { width: 20px; height: 20px; }
            .title { flex: 1; font-size: 14px; font-weight: 500; }
            .x { all: unset; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: #4f5648; font-size: 16px; cursor: pointer; }
            .x:hover { background: #f3f4f0; }
            .card { padding: 10px 0 8px; border-top: 1px solid #f0e9da; }
            .card:first-of-type { border-top: 0; }
            .name { display: flex; align-items: center; gap: 6px; font-weight: 600; }
            .name small { color: #087487; font-weight: 500; font-size: 11px; }
            .step { display: grid; grid-template-columns: 16px 74px minmax(0, 1fr); align-items: start; gap: 6px; margin-top: 5px; font-size: 12px; }
            .step b { font-weight: 500; }
            .step span { color: #4f5648; overflow-wrap: anywhere; }
            .ic { width: 12px; height: 12px; margin-top: 2px; border-radius: 50%; }
            .ic.waiting { border: 2px solid #e5e8e1; }
            .ic.busy { border: 2px solid #e5e8e1; border-top-color: #087487; animation: spin .8s linear infinite; }
            .ic.done { background: #168b5c; }
            .ic.error { background: #a32424; }
            .ic.skipped { background: #c4bba6; }
            @keyframes spin { to { transform: rotate(360deg); } }
            .actions { display: flex; gap: 6px; margin-top: 10px; }
            .actions button { all: unset; flex: 1; text-align: center; height: 32px; line-height: 32px; border: 1px solid #e5e8e1; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; }
            .actions button:hover { border-color: #c4bba6; }
            .mini { all: unset; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: #fff; box-shadow: 0 4px 14px rgba(26,31,23,.2); font: 500 13px system-ui, sans-serif; color: #1a1f17; cursor: pointer; }
            .mini img { width: 18px; height: 18px; }
            @media (prefers-color-scheme: dark) {
                .board, .mini { background: #222a26; color: #eef4ee; }
                .card { border-top-color: #3c4940; }
                .step span, .x { color: #aebcb2; }
                .actions button { border-color: #3c4940; }
            }
            @media (prefers-reduced-motion: reduce) { .ic.busy { animation: none; } }
        </style><div class="wrap"></div>`;
        root = shadow.querySelector(".wrap");
        root.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-act]");
            if (!btn) return;
            if (btn.dataset.act === "stop") chrome.runtime.sendMessage({ type: "stopAutopilot" }).catch(() => {});
            if (btn.dataset.act === "collapse") { collapsed = true; render(); }
            if (btn.dataset.act === "expand") { collapsed = false; render(); }
            if (btn.dataset.act === "close") hide();
        });
        document.documentElement.appendChild(host);
    }

    function render() {
        if (!root || !last) return;
        const icon = `<img src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="">`;
        if (collapsed) {
            const busy = last.cards.find((c) => c.current);
            root.innerHTML = `<button class="mini" data-act="expand">${icon}${esc(last.running ? `Autopilot · ${busy ? busy.name : "working"}` : last.title)}</button>`;
            return;
        }
        root.innerHTML = `<div class="board" role="status" aria-live="polite" aria-label="Finstracker autopilot">
            <div class="head">${icon}<span class="title">${esc(last.title)}</span><button class="x" data-act="${last.running ? "collapse" : "close"}" aria-label="${last.running ? "Minimize" : "Close"}">${last.running ? "–" : "×"}</button></div>
            ${last.cards.map((c) => `<div class="card"><div class="name">${esc(c.name)}${c.current ? "<small>now</small>" : ""}</div>
                ${c.steps.map((s) => `<div class="step"><i class="ic ${esc(s.state)}" aria-hidden="true"></i><b>${esc(s.name)}</b><span>${esc(s.text || (s.state === "waiting" ? "Waiting" : ""))}</span></div>`).join("")}</div>`).join("")}
            <div class="actions">${last.running ? '<button data-act="stop">Stop autopilot</button>' : '<button data-act="close">Close</button>'}</div>
        </div>`;
    }

    function show(board) {
        last = board;
        mount();
        render();
    }
    function hide() {
        host?.remove();
        host = root = null;
    }
    window.__finsBoard = { show, hide };
})();
