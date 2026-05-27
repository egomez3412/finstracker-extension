// extension/popup.js — UI controller for the Fins Sync popup.
//
// Mirrors the conventions used in client/js (toast notifications,
// cc:auth-changed style state events, .tabs + .card-form + .form-error
// patterns). Talks to the service worker via chrome.runtime.sendMessage;
// never holds the JWT in DOM state for longer than a single request.

import { getState, setState, onChanged } from "./lib/storage.js";

const $ = (id) => document.getElementById(id);
const views = {
    settings: $("settings-view"),
    auth: $("auth-view"),
    cards: $("cards-view"),
};

// ---- Theme -------------------------------------------------------------
// Theme is stored in chrome.storage.local under `theme` ("system" |
// "light" | "dark"). We apply it by setting `data-theme` on <html> so the
// CSS variables in popup.css can swap palettes. "system" leaves the
// attribute absent so the prefers-color-scheme media query takes over.
function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") {
        root.setAttribute("data-theme", theme);
    } else {
        root.removeAttribute("data-theme");
    }
}
// Apply the persisted theme as early as possible to avoid a flash.
getState(["theme"]).then(({ theme }) => applyTheme(theme)).catch(() => {});

function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = (k !== name);
    // Keep the gear/X icon in sync with whether the settings page is active.
    const toggle = document.getElementById("settings-toggle");
    if (toggle) {
        const isSettings = name === "settings";
        toggle.setAttribute("aria-expanded", isSettings ? "true" : "false");
        toggle.setAttribute("aria-label", isSettings ? "Close settings" : "Settings");
        toggle.setAttribute("title", isSettings ? "Close settings" : "Settings");
    }
}

function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

// Toast helper — same shape as client/js/toast.js (message + kind class).
let toastTimer = null;
function toast(message, kind = "") {
    const t = $("toast");
    if (!t) return;
    t.textContent = message;
    t.className = "show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ""; }, 3000);
}

function fmtBalance(card) {
    if (card.rewardType === "points") {
        return `${Number(card.currentPoints || 0).toLocaleString()} pts`;
    }
    return `$${Number(card.currentCashBack || 0).toFixed(2)}`;
}

function setFormError(form, message) {
    const el = form.querySelector(".form-error");
    if (el) el.textContent = message || "";
}

// ---- card-face theme helpers (mirror client/js/cards.js) ----------------
function issuerTheme(issuer) {
    const k = String(issuer || "").toLowerCase();
    if (k.includes("chase")) return "sapphire";
    if (k.includes("american express") || k.includes("amex")) return "platinum";
    if (k.includes("capital one")) return "ember";
    if (k.includes("citi")) return "midnight";
    if (k.includes("discover")) return "sunset";
    if (k.includes("wells")) return "crimson";
    if (k.includes("bank of america")) return "ruby";
    if (k.includes("u.s. bank") || k.includes("us bank")) return "slate";
    return "noir";
}
function nameTheme(name) {
    const k = String(name || "").toLowerCase();
    if (k.includes("sapphire")) return "sapphire";
    if (k.includes("reserve")) return "reserve";
    if (k.includes("platinum")) return "platinum";
    if (k.includes("gold")) return "gold";
    if (k.includes("green")) return "forest";
    if (k.includes("blue cash") || k.includes("blue")) return "azure";
    if (k.includes("freedom")) return "teal";
    if (k.includes("ink")) return "ink";
    if (k.includes("venture x")) return "ventureX";
    if (k.includes("venture")) return "venture";
    if (k.includes("savor")) return "savor";
    if (k.includes("quicksilver")) return "silver";
    if (k.includes("double cash") || k.includes("custom cash") || k.includes("active cash")) return "cash";
    if (k.includes("premier")) return "premier";
    if (k.includes("miles")) return "miles";
    if (k.includes("altitude")) return "altitude";
    if (k.includes("travel")) return "travel";
    if (k.includes("rewards")) return "rewards";
    return null;
}
function pickTheme(issuer, name) {
    const i = String(issuer || "").toLowerCase();
    if (i.includes("bank of america")) return "ruby";
    if (i.includes("wells")) return "crimson";
    if (i.includes("discover")) return "sunset";
    return nameTheme(name) || issuerTheme(issuer);
}
function fakeLast4(id) {
    let h = 0;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return String(h % 10000).padStart(4, "0");
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// Friendly relative timestamp for the "Updated …" line on each tile.
// Mirrors the cadence the marketing site uses ("just now / 5m ago /
// 3h ago / 2d ago / Mar 4"). Returns "" for missing dates so the meta
// row collapses cleanly.
function formatUpdatedAt(value) {
    if (!value) return "";
    const t = new Date(value).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    if (diff < 0) return "just now";
    const sec = Math.floor(diff / 1000);
    if (sec < 45) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    try {
        return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
        return new Date(t).toDateString();
    }
}

// ---- routing -------------------------------------------------------------

async function refresh() {
    const { apiBase, token, user, captureSession, autoDetect, theme } = await getState();
    $("auto-detect-input").value = autoDetect ? "true" : "false";
    $("theme-input").value = theme || "system";
    applyTheme(theme);
    $("logout-btn").hidden = !token;

    if (!token) { show("auth"); return; }

    show("cards");
    $("user-line").querySelector(".who").textContent = user ? user.username : "";
    await renderCaptureBanner(captureSession);
    await renderCards();
}

async function renderCaptureBanner(session) {
    const el = $("capture-banner");
    if (!session) { el.hidden = true; el.innerHTML = ""; el.className = "banner"; return; }
    el.hidden = false;

    // Terminal success states: synced (value pulled + posted) and
    // configured (selector saved). Show a compact confirmation, no
    // "pick element" CTA, and a single "Done" button to clear the
    // session so the banner goes away.
    const isSuccess = session.status === "synced" || session.status === "configured";
    if (isSuccess) {
        const valueStr = session.lastScrape?.value != null
            ? Number(session.lastScrape.value).toLocaleString()
            : null;
        const headline = session.status === "synced"
            ? (valueStr ? `Pulled ${valueStr} for ${session.cardName}` : `Pulled ${session.cardName}`)
            : `Selector saved for ${session.cardName}`;
        el.className = "banner banner-success";
        el.innerHTML = `
            <div class="banner-headline">
                <span class="banner-check" aria-hidden="true">\u2713</span>
                <strong class="banner-title"></strong>
            </div>
            <div class="form-row">
                <button type="button" id="banner-done">Done</button>
            </div>
        `;
        el.querySelector(".banner-title").textContent = headline;
        $("banner-done").addEventListener("click", async () => {
            await send({ type: "cancelCapture" });
        });
        return;
    }

    // Error path keeps the manual picker fallback so the user can rescue
    // a bad heuristic pick.
    if (session.status === "error") {
        el.className = "banner banner-error";
        el.innerHTML = `
            <div><strong>Couldn\u2019t pull ${escapeHtml(session.cardName)}</strong> \u2014 <span class="banner-detail"></span></div>
            <div class="form-row">
                <button type="button" id="banner-pick">Pick element manually</button>
                <button type="button" id="banner-cancel" class="secondary">Cancel</button>
            </div>
        `;
        el.querySelector(".banner-detail").textContent = session.lastError || "unknown";
        $("banner-pick").addEventListener("click", async () => {
            const r = await send({ type: "openPicker" });
            if (!r?.ok) toast(r?.error || "Picker failed to open", "error");
        });
        $("banner-cancel").addEventListener("click", async () => {
            await send({ type: "cancelCapture" });
            toast("Capture cancelled");
        });
        return;
    }

    // In-progress states: awaiting-login / watching / opening.
    const detail =
        session.status === "awaiting-login" ? `Sign in to ${session.issuer} \u2014 we\u2019ll grab your points automatically.` :
        session.status === "watching"       ? `Reading ${session.cardName} \u2026` :
                                              `Waiting for ${session.cardName} (${session.issuer}) page to load\u2026`;
    el.className = "banner";
    el.innerHTML = `
        <div><strong>Capture in progress</strong> \u2014 <span class="banner-detail"></span></div>
        <div class="form-row">
            <button type="button" id="banner-pick">Pick element manually</button>
            <button type="button" id="banner-cancel" class="secondary">Cancel</button>
        </div>
    `;
    el.querySelector(".banner-detail").textContent = detail;
    $("banner-pick").addEventListener("click", async () => {
        const r = await send({ type: "openPicker" });
        if (!r?.ok) toast(r?.error || "Picker failed to open", "error");
    });
    $("banner-cancel").addEventListener("click", async () => {
        await send({ type: "cancelCapture" });
        toast("Capture cancelled");
    });
}

// In-popup ephemeral state for each card: "syncing" | "success" | "error"
// Mapped by card.id. Keys are cleared automatically after a short delay so
// the success/error sash fades on its own.
const cardStates = new Map(); // id -> { kind, message, ts }
const cardStateTimers = new Map();
let cardsCache = [];
let cardsLoadedOnce = false;

function setCardState(cardId, kind, message) {
    if (!cardId) return;
    cardStates.set(cardId, { kind, message: message || "", ts: Date.now() });
    clearTimeout(cardStateTimers.get(cardId));
    if (kind === "success" || kind === "error") {
        cardStateTimers.set(cardId, setTimeout(() => {
            cardStates.delete(cardId);
            cardStateTimers.delete(cardId);
            renderCards();
        }, kind === "success" ? 3500 : 5000));
    }
    renderCards();
}

async function renderCards() {
    const status = $("cards-status");
    const list = $("card-list");

    // Only show "Loading…" the first time around; subsequent re-renders
    // (caused by capture status or per-card state changes) should not flash.
    if (!cardsLoadedOnce) {
        status.textContent = "Loading cards\u2026";
        status.className = "status";
        const r = await send({ type: "listCards" });
        if (!r?.ok) {
            status.textContent = r?.error || "Failed to load cards";
            status.className = "status err";
            // Surface auth / config issues with a re-login affordance so
            // the user can recover without digging into Settings.
            const isAuth = /not logged|unauthor|401|invalid|session expired/i.test(r?.error || "");
            if (isAuth) {
                await setState({ token: null, user: null });
                cardsLoadedOnce = false;
                cardsCache = [];
                show("auth");
                toast("Session expired — please sign in again", "error");
            }
            return;
        }
        cardsCache = r.cards || [];
        cardsLoadedOnce = true;
        status.textContent = "";
        console.log("[finstracker] listCards \u2192", cardsCache.length, "cards");
    } else {
        // Refresh balances quietly.
        const r = await send({ type: "listCards" });
        if (r?.ok) cardsCache = r.cards || [];
    }

    const { portalOverrides, captureSession, apiBase, user } = await getState([
        "portalOverrides", "captureSession", "apiBase", "user",
    ]);
    list.innerHTML = "";
    if (!cardsCache.length) {
        // Empty state with full diagnostics: which backend, which user,
        // and a one-click way to verify / re-login. The original
        // "No cards yet" copy was misleading whenever the cause was
        // actually a stale token or wrong apiBase.
        const safeUser = escapeHtml(user?.username || "(unknown)");
        const safeBase = escapeHtml(apiBase || "(default)");
        list.innerHTML = `
            <li class="empty-cards">
                <p><strong>No cards returned for ${safeUser}.</strong></p>
                <p class="muted">Backend: ${safeBase}</p>
                <p class="muted">If you have cards on the web app, you may be signed
                into a different account here, or your session has expired.</p>
                <div class="form-row">
                    <button type="button" id="empty-refresh">Refresh</button>
                    <button type="button" id="empty-relogin" class="secondary">Sign out &amp; sign back in</button>
                </div>
            </li>
        `;
        $("empty-refresh")?.addEventListener("click", async () => {
            cardsLoadedOnce = false;
            await renderCards();
        });
        $("empty-relogin")?.addEventListener("click", async () => {
            await send({ type: "logout" });
            await setState({ token: null, user: null });
            cardsLoadedOnce = false;
            cardsCache = [];
            show("auth");
        });
        return;
    }

    // Sort: actively-syncing card first, then most-recently-updated.
    // This makes the card we're capturing the obvious focal point and
    // matches the dashboard expectation that recent activity rises.
    const activeCardId = captureSession?.cardId || null;
    const sorted = cardsCache.slice().sort((a, b) => {
        if (a.id === activeCardId && b.id !== activeCardId) return -1;
        if (b.id === activeCardId && a.id !== activeCardId) return 1;
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bt - at;
    });

    for (const card of sorted) {
        list.appendChild(buildCardTile(card, portalOverrides, captureSession));
    }

    // When the active card changes (e.g. the user just clicked Update
    // Points or the background swapped sessions), scroll it into view
    // and run a brief highlight so the user's eye follows the move.
    if (activeCardId && activeCardId !== lastActiveCardId) {
        const tile = list.querySelector(`.card-tile[data-card-id="${CSS.escape(activeCardId)}"]`);
        if (tile) {
            tile.classList.add("is-rising");
            scrollCardIntoView(tile);
            setTimeout(() => tile.classList.remove("is-rising"), 700);
        }
    }
    lastActiveCardId = activeCardId;
}

// Tracks the previous active capture card across renders so we only
// animate / scroll when it actually changes.
let lastActiveCardId = null;

function buildCardTile(card, portalOverrides, captureSession) {
    const li = document.createElement("li");
    li.className = "card-tile";
    li.dataset.cardId = card.id;

    const balance = card.rewardType === "points"
        ? `${Number(card.currentPoints || 0).toLocaleString()} pts`
        : `$${Number(card.currentCashBack || 0).toFixed(2)}`;
    const theme = pickTheme(card.issuer, card.displayName);
    const last4 = fakeLast4(card.id);
    const override = portalOverrides?.[card.id];
    // Card view stays clean \u2014 URL / selector details belong in Settings.
    const hasCustomMapping = Boolean(override?.selector);

    // Per-card status: explicit local state wins; otherwise mirror the
    // active capture session if it belongs to this card.
    let stateKind = "";
    let stateMessage = "";
    const local = cardStates.get(card.id);
    if (local) {
        stateKind = local.kind;
        stateMessage = local.message;
    } else if (captureSession && captureSession.cardId === card.id) {
        if (captureSession.status === "synced") {
            stateKind = "success";
            stateMessage = captureSession.lastScrape?.value != null
                ? `Synced ${Number(captureSession.lastScrape.value).toLocaleString()}`
                : "Synced";
        } else if (captureSession.status === "error") {
            stateKind = "error";
            stateMessage = captureSession.lastError || "Sync failed";
        } else if (captureSession.status === "configured") {
            stateKind = "success";
            stateMessage = "Selector saved";
        } else {
            stateKind = "syncing";
            stateMessage = captureSession.statusLabel || "Waiting for portal…";
        }
    }
    if (stateKind) li.classList.add(`is-${stateKind}`);

    li.innerHTML = `
        <div class="cc-face" data-theme="${theme}" role="img"
             aria-label="${escapeHtml(card.displayName)} card, balance ${escapeHtml(balance)}">
            <div class="cc-top">
                <div class="cc-chip" aria-hidden="true"></div>
            </div>
            <div class="cc-number" aria-hidden="true">
                <span>\u2022\u2022\u2022\u2022</span>
                <span>\u2022\u2022\u2022\u2022</span>
                <span>\u2022\u2022\u2022\u2022</span>
                <span>${last4}</span>
            </div>
            <div class="cc-bottom">
                <div class="cc-holder">
                    <div class="cc-label">Card</div>
                    <div class="cc-name">${escapeHtml(card.displayName)}</div>
                    <div class="cc-issuer">${escapeHtml(card.issuer)}</div>
                </div>
                <div class="cc-balance">
                    <div class="cc-label">Balance</div>
                    <div class="cc-value">${escapeHtml(balance)}</div>
                </div>
            </div>
            <div class="cc-sash" aria-live="polite">
                ${stateKind === "syncing" ? '<span class="cc-spinner" aria-hidden="true"></span>' : ""}
                ${stateKind === "success" ? '<span class="cc-check" aria-hidden="true">\u2713</span>' : ""}
                ${stateKind === "error" ? '<span class="cc-x" aria-hidden="true">\u26A0</span>' : ""}
                <span class="cc-sash-text">${escapeHtml(stateMessage)}</span>
            </div>
        </div>
        ${hasCustomMapping ? '<p class="card-meta muted">Custom portal configured</p>' : ""}
        ${card.updatedAt ? `<p class="card-meta card-updated muted" title="${escapeHtml(new Date(card.updatedAt).toLocaleString())}">Updated ${escapeHtml(formatUpdatedAt(card.updatedAt))}</p>` : ""}
        <div class="actions">
            <button type="button" data-act="update">Update points</button>
            <button type="button" class="secondary" data-act="sync-offers" title="Open the ${escapeHtml(card.issuer || "issuer")} offers page and pull every active deal">Sync offers</button>
            <button type="button" class="secondary" data-act="sync-tab" title="Read whichever is on your current tab \u2014 points balance or offer list">Sync tab</button>
        </div>
    `;

    li.querySelector("[data-act='update']").addEventListener("click", () => onUpdate(card, "auto"));
    li.querySelector("[data-act='sync-tab']").addEventListener("click", () => onSyncTab(card));
    li.querySelector("[data-act='sync-offers']")?.addEventListener("click", () => onSyncOffers(card));
    return li;
}

// ---- actions -------------------------------------------------------------

async function onUpdate(card, mode) {
    // Dedupe rules:
    // - If a session exists for THIS card AND it's still in a live state
    //   (opening / awaiting-login / watching) AND the tab is still open,
    //   focus that tab instead of opening another.
    // - Terminal states (synced / configured / error) or a missing tab
    //   mean the previous session is stale; clear it and start fresh.
    //   Without this, clicking Update Points on a card we already synced
    //   leaves the UI stuck on "Opening \u2026" because the early return
    //   skips startCapture.
    const LIVE_STATES = new Set(["opening", "awaiting-login", "watching"]);
    const { captureSession } = await getState(["captureSession"]);
    if (captureSession && captureSession.cardId === card.id && captureSession.tabId) {
        const isLive = LIVE_STATES.has(captureSession.status);
        let tabAlive = false;
        if (isLive) {
            try {
                const tab = await chrome.tabs.get(captureSession.tabId);
                if (tab && tab.id) {
                    tabAlive = true;
                    await chrome.tabs.update(captureSession.tabId, { active: true });
                    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
                }
            } catch { /* tab closed; fall through to fresh capture */ }
        }
        if (isLive && tabAlive) {
            setCardState(card.id, "syncing", `Already watching ${card.issuer}\u2026`);
            return;
        }
        // Stale or terminal session — clear it before opening a new portal.
        await send({ type: "cancelCapture" });
    }

    setCardState(card.id, "syncing", `Opening ${card.issuer}\u2026`);
    // Optimistically pin this card to the top of the visible stack with
    // a small "rise" animation. The real reorder happens once the
    // background pushes captureSession; this just gives the user instant
    // feedback that the click registered.
    pinCardToTop(card.id);

    const r = await send({ type: "startCapture", card, mode });
    if (!r?.ok) {
        setCardState(card.id, "error", r?.error || "Could not start capture");
        toast(r?.error || "Could not start capture", "error");
        return;
    }
    toast(`Opened ${card.issuer} portal \u2014 sign in and the points will sync automatically`, "success");
}

// Move the chosen card's tile to the top of the rendered list with a
// short rise animation, and scroll the cards view so the card is fully
// visible. Called eagerly from onUpdate() for instant feedback; the
// canonical reorder happens on the next renderCards() once the capture
// session updates.
function pinCardToTop(cardId) {
    const list = $("card-list");
    if (!list) return;
    const tile = list.querySelector(`.card-tile[data-card-id="${CSS.escape(cardId)}"]`);
    if (!tile) return;
    if (tile === list.firstElementChild) {
        scrollCardIntoView(tile);
        return;
    }
    // FLIP-lite: capture the start position, move to the top, then play
    // a translateY animation from the old offset to 0.
    const startTop = tile.getBoundingClientRect().top;
    list.insertBefore(tile, list.firstElementChild);
    const endTop = tile.getBoundingClientRect().top;
    const delta = startTop - endTop;
    if (delta) {
        tile.style.transform = `translateY(${delta}px)`;
        tile.style.transition = "none";
        // Force layout, then animate.
        // eslint-disable-next-line no-unused-expressions
        tile.offsetHeight;
        tile.style.transition = "transform 320ms cubic-bezier(.2,.7,.2,1)";
        tile.style.transform = "translateY(0)";
        tile.classList.add("is-rising");
        setTimeout(() => {
            tile.style.transition = "";
            tile.style.transform = "";
            tile.classList.remove("is-rising");
        }, 360);
    }
    scrollCardIntoView(tile);
}

function scrollCardIntoView(tile) {
    if (!tile) return;
    try {
        tile.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch { /* fall back silently */ }
}

async function onSyncTab(card) {
    setCardState(card.id, "syncing", "Reading current tab…");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        setCardState(card.id, "error", "No active tab");
        toast("No active tab", "error");
        return;
    }
    const r = await send({ type: "syncFromActiveTab", card, tabId: tab.id });
    if (!r?.ok) {
        setCardState(card.id, "error", r?.error || "Sync failed");
        toast(r?.error || "Sync failed", "error");
        return;
    }
    // Smart router returns either kind:"points" (with current/target/noop)
    // or kind:"offers" (with created/updated/received). Render both nicely.
    if (r.kind === "offers") {
        const created = r.created || 0;
        const refreshed = r.updated || 0;
        setCardState(card.id, "success", `+${created} new, ${refreshed} refreshed`);
        toast(`${card.displayName}: ${created} new offers, ${refreshed} refreshed`, "success");
    } else if (r.noop) {
        setCardState(card.id, "success", `Already at ${Number(r.target).toLocaleString()}`);
        toast(`${card.displayName} already at ${r.target}`, "success");
    } else {
        setCardState(card.id, "success", `${Number(r.current).toLocaleString()} \u2192 ${Number(r.target).toLocaleString()}`);
        toast(`${card.displayName}: ${r.current} \u2192 ${r.target}`, "success");
    }
    // Refresh balances so the new value lands in the card face too.
    cardsLoadedOnce = false;
    await renderCards();
}

// Offer sync now works for every issuer: when the issuer has a known
// portal (Chase / Amex / BoA) the background opens it and polls; for
// any other issuer the background scrapes whichever offers page the
// user already has open in the current tab.
async function onSyncOffers(card) {
    setCardState(card.id, "syncing", `Opening ${card.issuer || "issuer"} offers\u2026`);
    const r = await send({ type: "syncOffers", card });
    if (!r?.ok) {
        setCardState(card.id, "error", r?.error || "Couldn't sync offers");
        toast(r?.error || "Couldn't sync offers", "error");
        return;
    }
    const created = r.created || 0;
    const refreshed = r.updated || 0;
    setCardState(card.id, "success", `+${created} new, ${refreshed} refreshed`);
    toast(`${card.displayName}: ${created} new offers, ${refreshed} refreshed`, "success");
}

// ---- settings ------------------------------------------------------------

$("settings-toggle").addEventListener("click", async () => {
    // Toggle: gear opens settings, X (same button, swapped icon) closes it.
    const isOpen = $("settings-toggle").getAttribute("aria-expanded") === "true";
    if (isOpen) { await refresh(); return; }
    const { token } = await getState(["token"]);
    $("logout-btn").hidden = !token;
    await populateConfigureCards();
    show("settings");
});

$("settings-close").addEventListener("click", () => refresh());

// Save the General-section preferences. Used to live on the form's own
// submit button; consolidated into the page-level Save in the sticky
// action bar so the whole settings page reads like one form.
async function saveSettings() {
    const autoDetect = $("auto-detect-input").value === "true";
    const themeRaw = $("theme-input").value;
    const theme = themeRaw === "light" || themeRaw === "dark" ? themeRaw : "system";
    await setState({ autoDetect, theme });
    applyTheme(theme);
    setFormError($("settings-form"), "");
    toast("Settings saved", "success");
}

$("settings-save").addEventListener("click", async () => {
    await saveSettings();
    await refresh(); // Save also exits to the cards view, per the new UX.
});

// The General form no longer has its own submit button, but if a user
// hits Enter inside a field we still want to save in place rather than
// reload the popup.
$("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveSettings();
});

// Preview theme changes immediately so the user can see the swap before
// committing with Save. Reverts on Cancel because Cancel calls refresh()
// which re-applies the persisted theme.
$("theme-input").addEventListener("change", (e) => applyTheme(e.target.value));

// Sync theme across other side-panel windows / popups that may be open.
// chrome.storage.local is shared per-profile, so when one window saves a
// new theme we mirror it here without a full refresh().
onChanged((changes) => {
    if (changes.theme) {
        const t = changes.theme.newValue;
        applyTheme(t);
        const sel = $("theme-input");
        if (sel && sel.value !== t) sel.value = t || "system";
    }
});

$("logout-btn").addEventListener("click", async () => {
    await send({ type: "logout" });
    toast("Logged out");
    await refresh();
});

// Open the user's Finstracker dashboard in a new tab so they can see
// changes from the popup reflected in the web app.
$("open-dashboard-btn").addEventListener("click", async () => {
    const { apiBase } = await getState(["apiBase"]);
    const base = (apiBase || "https://finstracker.com").replace(/\/+$/, "");
    try {
        await chrome.tabs.create({ url: `${base}/app.html` });
    } catch {
        window.open(`${base}/app.html`, "_blank", "noopener");
    }
});

// ---- configure (settings) ------------------------------------------------

let configureCardsCache = [];

async function populateConfigureCards() {
    const select = $("configure-card-select");
    const meta = $("configure-card-meta");
    const clearBtn = $("configure-clear-btn");
    const form = $("configure-form");
    const { token } = await getState(["token"]);
    if (!token) {
        form.hidden = true;
        return;
    }
    form.hidden = false;
    const r = await send({ type: "listCards" });
    if (!r?.ok) {
        select.innerHTML = `<option value="">— Sign in to load cards —</option>`;
        return;
    }
    configureCardsCache = r.cards || [];
    const prev = select.value;
    select.innerHTML = `<option value="">— Select a card —</option>` +
        configureCardsCache.map((c) =>
            `<option value="${c.id}">${escapeHtml(c.displayName)} · ${escapeHtml(c.issuer)}</option>`
        ).join("");
    if (prev && configureCardsCache.some((c) => c.id === prev)) select.value = prev;
    await refreshConfigureMeta();
    meta.hidden = !select.value;
    clearBtn.hidden = !select.value;
}

async function refreshConfigureMeta() {
    const select = $("configure-card-select");
    const meta = $("configure-card-meta");
    const clearBtn = $("configure-clear-btn");
    if (!select.value) { meta.hidden = true; clearBtn.hidden = true; return; }
    const { portalOverrides } = await getState(["portalOverrides"]);
    const override = portalOverrides?.[select.value];
    if (override?.capturedUrl) {
        meta.hidden = false;
        meta.textContent = `Custom selector saved · captured from ${override.capturedUrl}`;
        clearBtn.hidden = false;
    } else {
        meta.hidden = false;
        meta.textContent = "Using the built-in default for this card's issuer.";
        clearBtn.hidden = true;
    }
}

$("configure-card-select").addEventListener("change", refreshConfigureMeta);

$("configure-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cardId = $("configure-card-select").value;
    setFormError(e.target, "");
    if (!cardId) { setFormError(e.target, "Pick a card first."); return; }
    const card = configureCardsCache.find((c) => c.id === cardId);
    if (!card) { setFormError(e.target, "Card not found."); return; }
    const r = await send({ type: "startCapture", card, mode: "configure" });
    if (!r?.ok) { setFormError(e.target, r?.error || "Could not start capture"); return; }
    window.close();
});

$("configure-clear-btn").addEventListener("click", async () => {
    const cardId = $("configure-card-select").value;
    if (!cardId) return;
    const r = await send({ type: "clearOverride", cardId });
    if (!r?.ok) { toast(r?.error || "Failed to reset", "error"); return; }
    toast("Reset to default", "success");
    await refreshConfigureMeta();
});

// ---- auth ----------------------------------------------------------------

// Web-bridge sign-in: we no longer collect credentials in the popup.
// Clicking the CTA opens the regular finstracker.com login page (which
// already does Turnstile, Google sign-in, password reset, etc.) and the
// page posts the JWT back to the extension via chrome.runtime.sendMessage.
// The background's onMessageExternal handler stores it, which triggers
// onChanged(token) below and routes the popup into the cards view.
const openSigninBtn = $("open-web-signin");
const signupLink = $("signup-web-link");
const bridgeStatus = $("auth-bridge-status");

function setBridgeStatus(message) {
    if (!bridgeStatus) return;
    bridgeStatus.textContent = message || "";
    bridgeStatus.hidden = !message;
}

async function buildSigninUrl() {
    const { apiBase } = await getState(["apiBase"]);
    const base = String(apiBase || "https://finstracker.com").replace(/\/$/, "");
    const params = new URLSearchParams({
        source: "extension",
        extId: chrome.runtime.id,
    });
    return `${base}/login.html?${params.toString()}`;
}

// Point the "Sign up on the web" link at the same apiBase the popup talks
// to, so a self-hosted deploy hands users back to their own signup page
// rather than finstracker.com.
(async () => {
    if (!signupLink) return;
    try {
        const { apiBase } = await getState(["apiBase"]);
        if (apiBase) {
            const base = String(apiBase).replace(/\/$/, "");
            const params = new URLSearchParams({
                source: "extension",
                extId: chrome.runtime.id,
            });
            signupLink.href = `${base}/signup.html?${params.toString()}`;
        }
    } catch (_e) { /* keep the hard-coded fallback */ }
})();

if (openSigninBtn) {
    openSigninBtn.addEventListener("click", async () => {
        try {
            const url = await buildSigninUrl();
            openSigninBtn.disabled = true;
            setBridgeStatus("Opening Finstracker\u2026 sign in there to finish.");
            await chrome.tabs.create({ url, active: true });
            setBridgeStatus("Waiting for sign-in\u2026 this view will refresh automatically.");
        } catch (err) {
            console.warn("open signin failed", err);
            setBridgeStatus("Couldn't open the sign-in tab. Try again.");
        } finally {
            openSigninBtn.disabled = false;
        }
    });
}

// Live-update when the background pushes capture status / auth changes.
onChanged((changes) => {
    if (changes.token) {
        cardsCache = [];
        cardsLoadedOnce = false;
        // If we were waiting on a web-bridge sign-in, clear the status and
        // greet the user. New token => signed in. Cleared token => signed out.
        if (changes.token.newValue) {
            setBridgeStatus("");
            toast("Welcome back!", "success");
        }
        refresh();
        return;
    }
    if (changes.captureSession) {
        const next = changes.captureSession.newValue;
        const prev = changes.captureSession.oldValue;
        // Mirror the capture session into per-card state so the success
        // sash auto-dismisses just like our local onSyncTab flow.
        if (next?.cardId) {
            if (next.status === "synced") {
                cardsLoadedOnce = false; // force balance refresh
                setCardState(next.cardId, "success",
                    next.lastScrape?.value != null
                        ? `Synced ${Number(next.lastScrape.value).toLocaleString()}`
                        : "Synced");
            } else if (next.status === "error") {
                setCardState(next.cardId, "error", next.lastError || "Sync failed");
            }
        } else if (prev?.cardId) {
            // Session was cleared (user cancelled the picker, dismissed,
            // etc.). Drop the lingering local "syncing"/"Opening …" sash
            // so the card face returns to its idle state immediately.
            const local = cardStates.get(prev.cardId);
            if (local && local.kind === "syncing") {
                cardStates.delete(prev.cardId);
                clearTimeout(cardStateTimers.get(prev.cardId));
                cardStateTimers.delete(prev.cardId);
            }
        }
        renderCaptureBanner(next);
        renderCards();
        return;
    }
    if (changes.portalOverrides) renderCards();
});

refresh();
