// Finstracker side panel: cards and points sync, credits, offers and the best card for the open site.
import { CATEGORY_LABELS } from "../lib/merchants.js";
import { rateLabel } from "../lib/best-card.js";
import { daysUntil, dueLabel, localToday, nextFeeDate, openCredits, openOffers, summary } from "../lib/benefits.js";
import { PRODUCTION, getState, onChanged, setState } from "../lib/storage.js";

const app = document.getElementById("app");
const CHECKOUT_ORIGINS = ["https://*/*"];
const state = {
    view: "loading", // loading | signin | home | settings
    tab: "cards", // cards | credits | offers
    user: null,
    apiBase: PRODUCTION,
    settings: { autoDetect: true, checkoutHints: false, theme: "system" },
    overrides: {},
    session: null,
    cards: null,
    credits: null,
    offers: null,
    advice: null,
    siteUrl: "",
    open: new Set(), // expanded card rows
    rowState: new Map(), // cardId → { kind, text }
    waitingForSignIn: false,
    configureCard: "",
};
let lastView = "";

/* ---------- helpers ---------- */

const send = (message) => chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: err?.message || "Extension error" }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const today = () => localToday();
const base = () => String(state.apiBase || PRODUCTION).replace(/\/$/, "");

function money(n, { cents = false } = {}) {
    const v = Number(n) || 0;
    const digits = cents || Math.round(v * 100) % 100 ? 2 : 0;
    return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const balanceText = (c) => (c.rewardType === "cashback" ? money(c.currentCashBack, { cents: true }) : `${Number(c.currentPoints || 0).toLocaleString()} pts`);
const balanceValue = (c) => (c.rewardType === "cashback" ? Number(c.currentCashBack) || 0 : ((Number(c.currentPoints) || 0) * (Number(c.pointValueCents) || 1)) / 100);
const baseTitle = (t) => String(t || "").split(" · ")[0];

const ISSUER_COLORS = [
    [/chase/i, "#1d4f9c"], [/american express|amex/i, "#5aa1e3"], [/capital one/i, "#c8102e"], [/citi/i, "#0e8a9c"],
    [/discover/i, "#e5761f"], [/wells/i, "#c4161c"], [/bank of america/i, "#b3122a"], [/u\.?s\.? bank/i, "#24387f"], [/barclays/i, "#00aeef"],
];
const issuerColor = (issuer) => ISSUER_COLORS.find(([rx]) => rx.test(issuer || ""))?.[1] || "#1d6b4a";

function ago(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    if (min < 1440) return `${Math.floor(min / 60)}h ago`;
    if (min < 10080) return `${Math.floor(min / 1440)}d ago`;
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

let toastTimer = 0;
function toast(text, { kind = "", undo = null } = {}) {
    const el = document.getElementById("toast");
    el.className = `toast show ${kind}`;
    el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
    if (undo) el.querySelector("button").onclick = () => { el.className = "toast"; undo(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, undo ? 5000 : 3200);
}

function applyTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
}

/* ---------- data ---------- */

function handleSignedOut(result) {
    if (result?.signedOut) {
        state.view = "signin";
        render();
        return true;
    }
    return false;
}

async function loadCards({ fresh = false } = {}) {
    const r = await send({ type: "listCards", fresh });
    if (handleSignedOut(r)) return;
    if (r.ok) state.cards = r.cards;
    else if (!state.cards) { state.cards = []; toast(r.error || "Couldn't load cards", { kind: "error" }); }
    render();
}
async function loadCredits() {
    const r = await send({ type: "listCredits" });
    if (handleSignedOut(r)) return;
    state.credits = r.ok ? r.credits : state.credits || [];
    render();
}
async function loadOffers() {
    const r = await send({ type: "listOffers" });
    if (handleSignedOut(r)) return;
    state.offers = r.ok ? r.offers : state.offers || [];
    render();
}
async function loadSite(force = false) {
    let tab;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { return; }
    const url = tab?.url || "";
    if (!force && url === state.siteUrl) return;
    state.siteUrl = url;
    const r = /^https?:/.test(url) ? await send({ type: "siteAdvice", url }) : null;
    state.advice = r?.ok ? r.advice : null;
    render();
}
function loadAll() {
    loadCards();
    loadCredits();
    loadOffers();
    loadSite(true);
}

/* ---------- views (same building blocks as the dashboard's standard tabs) ---------- */

const ICON_CHEV = '<svg class="chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const headLink = (href, label) => `<a class="btn-ghost btn-small" href="${esc(href)}" data-act="open-link">${esc(label)}</a>`;
const panel = (title, action, body, extra = "") => `<section class="panel"${extra}><div class="panel-head"><h2>${esc(title)}</h2>${action || ""}</div>${body}</section>`;
const placeholderRows = (n = 3) => `<div class="panel-body">${'<div class="ph ph-row"></div>'.repeat(n)}</div>`;
const emptyState = (title, text) => `<div class="empty-state"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ""}</div>`;

function signinView() {
    return `<section class="view signin" data-view="signin">
        <h1 class="page-title">Sign in to Finstracker</h1>
        <button type="button" class="btn-primary" data-act="signin" ${state.waitingForSignIn ? "disabled" : ""}>${state.waitingForSignIn ? "Waiting for sign-in…" : "Sign in on finstracker.com"}</button>
        <a class="link-btn" href="${esc(base())}/signup" data-act="open-link">Create an account</a>
    </section>`;
}

function statusStrip() {
    const s = state.session;
    if (!s) return "";
    const offers = s.kind === "offers";
    const btn = (act, label, primary = false) => `<button type="button" class="${primary ? "btn-primary" : "btn-ghost"} btn-small" data-act="${act}">${label}</button>`;
    let icon, title, sub = "", buttons;
    if (s.status === "synced" || s.status === "configured") {
        icon = '<span class="dot dot-good" aria-hidden="true"></span>';
        title = offers ? s.statusLabel || "Offers saved" : s.status === "configured" ? "Balance spot saved" : `${s.cardName} synced`;
        if (!offers && s.lastScrape?.value != null) sub = Number(s.lastScrape.value).toLocaleString();
        buttons = btn("dismiss-session", "Done");
    } else if (s.status === "error") {
        icon = '<span class="dot dot-bad" aria-hidden="true"></span>';
        title = `Couldn't sync ${s.cardName || ""}`;
        sub = s.lastError || "Something went wrong";
        buttons = (offers ? "" : btn("session-pick", "Pick the balance", true)) + btn("dismiss-session", "Dismiss");
    } else {
        icon = '<span class="spinner" aria-hidden="true"></span>';
        title = s.statusLabel || `Syncing ${s.cardName || ""}`;
        buttons = (offers || s.status === "picking" ? "" : btn("session-pick", "Pick the balance")) + btn("dismiss-session", "Cancel");
    }
    return `<section class="panel status"${s.status === "error" ? ' role="alert"' : ""}><div class="panel-body">
        <div class="row">${icon}<div class="row-main"><div class="row-title">${esc(title)}</div>${sub ? `<div class="row-sub wrap">${esc(sub)}</div>` : ""}</div></div>
        <div class="action-row">${buttons}</div>
    </div></section>`;
}

function siteBlock() {
    const a = state.advice;
    if (!a?.ranked?.length) return "";
    const [best, ...rest] = a.ranked;
    const name = a.context.guessed ? "this checkout" : a.context.name;
    const others = rest.filter((r) => r.cents < best.cents || r.rate !== best.rate).slice(0, 2);
    const offers = (a.offers || []).slice(0, 3);
    return panel(`Best card on ${name}`, `<span class="muted small">${esc(a.label || CATEGORY_LABELS[a.context.category])}</span>`, `<div class="panel-body card-summary">
        <span class="summary-kicker">Pay with</span>
        <strong class="summary-big">${esc(best.card.displayName)}</strong>
        <span class="row-sub">${esc(rateLabel(best.card, best.rate))} · ${esc(best.cents)}¢ back per $1</span>
        ${others.length ? `<dl class="summary-list">${others.map((r) => `<div><dt>${esc(r.card.displayName)}</dt><dd>${esc(rateLabel(r.card, r.rate))} · ${esc(r.cents)}¢</dd></div>`).join("")}</dl>` : ""}
        ${offers.length ? `<h3 class="card-summary-section-title">Offers here</h3><dl class="summary-list">${offers.map((o) => `<div><dt>${esc(o.title || o.merchant)}</dt><dd>${esc([o.cardName, o.expiresAt ? dueLabel(o.expiresAt, today()) : ""].filter(Boolean).join(" · "))}</dd></div>`).join("")}</dl>` : ""}
    </div>`, ' aria-label="Best card on this site"');
}

function statsBlock() {
    if (!state.cards || !state.credits || !state.offers) return `<div class="panel metrics">${'<div class="metric"><div class="ph ph-metric"></div></div>'.repeat(3)}</div>`;
    const s = summary({ cards: state.cards, perks: state.credits, offers: state.offers, today: today() });
    const metric = (tab, label, value) => `<button type="button" data-act="tab" data-tab="${tab}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${ICON_CHEV}</button>`;
    return `<div class="panel metrics">
        ${metric("credits", "Credits", money(s.creditsValue))}
        ${metric("offers", "Offers", String(s.offersCount))}
        ${metric("cards", "Fees due", money(s.feesDue))}
    </div>`;
}

function tabsBlock() {
    const t = (id, label) => `<button type="button" role="tab" class="tab" aria-selected="${state.tab === id}" data-act="tab" data-tab="${id}">${label}</button>`;
    return `<div class="tabs" role="tablist">${t("cards", "Cards")}${t("credits", "Credits")}${t("offers", "Offers")}</div>`;
}

function cardRow(card) {
    const open = state.open.has(card.id);
    const rs = state.rowState.get(card.id);
    const fee = nextFeeDate(card, today());
    const override = state.overrides[card.id];
    const sub = rs
        ? `<span class="row-state is-${rs.kind}">${rs.kind === "syncing" ? '<span class="spinner" aria-hidden="true"></span>' : ""}${esc(rs.text)}</span>`
        : esc([card.issuer, card.updatedAt ? `Updated ${ago(card.updatedAt)}` : ""].filter(Boolean).join(" · "));
    return `<li class="row-wrap ${open ? "open" : ""}" data-card="${esc(card.id)}">
        <button type="button" class="row row-button" data-act="toggle-card" data-id="${esc(card.id)}" aria-expanded="${open}">
            <span class="dot" style="background:${issuerColor(card.issuer)}"></span>
            <span class="row-main"><span class="row-title">${esc(card.displayName)}</span><span class="row-sub">${sub}</span></span>
            <span class="row-amount">${esc(balanceText(card))}</span>
        </button>
        <div class="row-detail"><div><div class="row-detail-inner">
            <dl class="summary-list">
                <div><dt>Worth about</dt><dd>${esc(money(Math.round(balanceValue(card))))}</dd></div>
                ${card.annualFee > 0 ? `<div><dt>Annual fee</dt><dd>${esc(money(card.annualFee))}${fee ? ` · ${esc(shortDate(fee))}` : ""}</dd></div>` : ""}
                ${override ? `<div><dt>Balance spot</dt><dd>${override.source === "user-picker" ? "Your pick" : "Learned"}</dd></div>` : ""}
            </dl>
            <div class="action-row">
                <button type="button" class="btn-primary btn-small" data-act="update" data-id="${esc(card.id)}">Update points</button>
                <button type="button" class="btn-ghost btn-small" data-act="sync-offers" data-id="${esc(card.id)}">Sync offers</button>
                <button type="button" class="btn-ghost btn-small" data-act="read-tab" data-id="${esc(card.id)}">Read this tab</button>
                <button type="button" class="btn-ghost btn-small" data-act="pick" data-id="${esc(card.id)}">Pick the balance</button>
            </div>
        </div></div></div>
    </li>`;
}

function cardsPanel() {
    const action = headLink(`${base()}/cards`, "All cards");
    if (!state.cards) return panel("Your cards", action, placeholderRows());
    if (!state.cards.length) return panel("Your cards", headLink(`${base()}/cards`, "Add a card"), emptyState("No cards yet"));
    const active = state.session?.cardId;
    const list = [...state.cards].sort((a, b) => (b.id === active) - (a.id === active) || String(a.displayName).localeCompare(String(b.displayName)));
    return panel("Your cards", action, `<div class="panel-body"><ul class="rows">${list.map(cardRow).join("")}</ul></div>`);
}

const useRow = (kind, id, title, sub, amount) => `<li class="row" data-${kind}="${esc(id)}">
    <div class="row-main"><div class="row-title">${esc(title)}</div><div class="row-sub">${esc(sub)}</div></div>
    <span class="row-amount">${amount ? esc(amount) : ""}</span>
    <button type="button" class="btn-ghost btn-small" data-act="use-${kind}" data-id="${esc(id)}">Mark used</button>
</li>`;

function creditsPanel() {
    const action = headLink(`${base()}/perks?tab=perks`, "All benefits");
    if (!state.credits || !state.cards) return panel("Credits to use", action, placeholderRows());
    const list = openCredits(state.credits, today());
    if (!list.length) return panel("Credits to use", action, emptyState("No unused credits"));
    const byId = Object.fromEntries(state.cards.map((c) => [c.id, c]));
    const row = (p) => useRow("credit", p.id, baseTitle(p.title), [byId[p.cardId]?.displayName, p.deadline ? `ends ${dueLabel(p.deadline, today())}` : "", p.capLabel].filter(Boolean).join(" · "), money((p.valueCents || 0) / 100));
    const soon = list.filter((p) => daysUntil(p.deadline, today()) <= 30), later = list.filter((p) => daysUntil(p.deadline, today()) > 30);
    const group = (label, rows) => (rows.length ? `<li class="eyebrow group-label">${label}</li>${rows.map(row).join("")}` : "");
    return panel("Credits to use", action, `<div class="panel-body"><ul class="rows">${group("Ending within 30 days", soon)}${group("Later", later)}</ul></div>`);
}

function offersPanel() {
    const action = headLink(`${base()}/perks?tab=offers`, "All offers");
    if (!state.offers || !state.cards) return panel("Open offers", action, placeholderRows());
    const list = openOffers(state.offers, today());
    if (!list.length) return panel("Open offers", action, emptyState("No open offers"));
    const byId = Object.fromEntries(state.cards.map((c) => [c.id, c]));
    return panel("Open offers", action, `<div class="panel-body"><ul class="rows">${list.map((o) => useRow("offer", o.id, o.merchant,
        [byId[o.cardId]?.displayName, o.minSpendCents ? `on ${money(o.minSpendCents / 100)}+` : "", o.expiresAt ? `ends ${dueLabel(o.expiresAt, today())}` : ""].filter(Boolean).join(" · "),
        o.valueCents ? money(o.valueCents / 100) : "")).join("")}</ul></div>`);
}

function homeView() {
    const body = state.tab === "credits" ? creditsPanel() : state.tab === "offers" ? offersPanel() : cardsPanel();
    return `<div class="view" data-view="home">${statusStrip()}${siteBlock()}${statsBlock()}${tabsBlock()}${body}</div>`;
}

function settingsView() {
    const s = state.settings;
    const toggle = (act, on, label) => `<button type="button" class="toggle" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="${act}"><span class="toggle-thumb"></span></button>`;
    const theme = (value, label) => `<button type="button" role="tab" aria-selected="${s.theme === value}" data-act="theme" data-value="${value}">${label}</button>`;
    const cards = state.cards || [];
    const picked = cards.find((c) => c.id === state.configureCard);
    const line = (label, control) => `<li class="row"><div class="row-main"><div class="row-title">${esc(label)}</div></div>${control}</li>`;
    return `<div class="view" data-view="settings">
        <h1 class="page-title">Settings</h1>
        ${panel("Sync", "", `<div class="panel-body"><ul class="rows">
            ${line("Offer to sync on card portals", toggle("toggle-autodetect", s.autoDetect, "Offer to sync on card portals"))}
            ${line("Best card at checkout", toggle("toggle-checkout", s.checkoutHints, "Best card at checkout"))}
        </ul></div>`)}
        ${panel("Appearance", "", `<div class="panel-body"><ul class="rows">${line("Theme", `<div class="seg" role="tablist" aria-label="Theme">${theme("system", "System")}${theme("light", "Light")}${theme("dark", "Dark")}</div>`)}</ul></div>`)}
        ${panel("Balance spots", "", `<div class="panel-body form-stack">
            <select class="select" data-act="configure-card" aria-label="Card">
                <option value="">Choose a card</option>
                ${cards.map((c) => `<option value="${esc(c.id)}" ${c.id === state.configureCard ? "selected" : ""}>${esc(c.displayName)} · ${esc(c.issuer)}</option>`).join("")}
            </select>
            ${picked ? `<div class="action-row"><button type="button" class="btn-primary btn-small" data-act="configure" data-id="${esc(picked.id)}">Open portal and pick</button>${state.overrides[picked.id] ? `<button type="button" class="btn-ghost btn-small" data-act="reset-spot" data-id="${esc(picked.id)}">Reset</button>` : ""}</div>` : ""}
        </div>`)}
        ${panel("Account", "", `<div class="panel-body"><ul class="rows"><li class="row"><div class="row-main"><div class="row-title">${esc(state.user?.username || state.user?.email || "Signed in")}</div>${state.apiBase !== PRODUCTION ? `<div class="row-sub">${esc(state.apiBase)}</div>` : ""}</div><button type="button" class="btn-ghost btn-small btn-danger-text" data-act="signout">Sign out</button></li></ul></div>`)}
    </div>`;
}

function render() {
    const focused = document.activeElement?.closest?.("[data-act]");
    const focusKey = focused ? `${focused.dataset.act}|${focused.dataset.id || focused.dataset.tab || focused.dataset.value || ""}` : "";
    const html = state.view === "signin" ? signinView() : state.view === "settings" ? settingsView() : state.view === "home" ? homeView() : `<div class="view">${statsBlock()}<section class="panel">${placeholderRows()}</section></div>`;
    app.innerHTML = html;
    // Only animate when the view itself changes, not on every refresh.
    const view = app.querySelector(".view");
    if (view && state.view === lastView) view.style.animation = "none";
    lastView = state.view;

    const toggle = document.getElementById("settings-toggle");
    toggle.hidden = state.view === "signin" || state.view === "loading";
    toggle.setAttribute("aria-expanded", String(state.view === "settings"));
    toggle.setAttribute("aria-label", state.view === "settings" ? "Close settings" : "Settings");
    document.getElementById("open-dashboard").hidden = state.view !== "home" && state.view !== "settings";

    if (focusKey) {
        const [act, key] = focusKey.split("|");
        const again = [...app.querySelectorAll(`[data-act="${act}"]`)].find((el) => (el.dataset.id || el.dataset.tab || el.dataset.value || "") === key);
        again?.focus({ preventScroll: true });
    }
}

/* ---------- actions ---------- */

function setRowState(cardId, kind, text) {
    state.rowState.set(cardId, { kind, text });
    render();
    if (kind !== "syncing") {
        setTimeout(() => {
            if (state.rowState.get(cardId)?.text === text) { state.rowState.delete(cardId); render(); }
        }, kind === "success" ? 4000 : 6000);
    }
}
const cardById = (id) => state.cards?.find((c) => c.id === id);

async function openUrl(url) {
    try { await chrome.tabs.create({ url, active: true }); } catch { window.open(url, "_blank", "noopener"); }
}

async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function markCredit(id, used) {
    const item = state.credits.find((p) => p.id === id);
    if (!item) return;
    const row = app.querySelector(`[data-credit="${CSS.escape(id)}"]`);
    if (used && row) { row.classList.add("leaving"); await new Promise((r) => setTimeout(r, 260)); }
    item.used = used;
    render();
    const r = await send({ type: "setCreditUsed", id, used });
    if (handleSignedOut(r)) return;
    if (!r.ok) { item.used = !used; render(); toast(r.error || "Couldn't update the credit", { kind: "error" }); return; }
    if (used) toast(`${baseTitle(item.title)} marked used`, { undo: () => markCredit(id, false) });
}

async function markOffer(id, used) {
    const item = state.offers.find((o) => o.id === id);
    if (!item) return;
    const row = app.querySelector(`[data-offer="${CSS.escape(id)}"]`);
    if (used && row) { row.classList.add("leaving"); await new Promise((r) => setTimeout(r, 260)); }
    item.used = used;
    render();
    const r = await send({ type: "setOfferUsed", id, used });
    if (handleSignedOut(r)) return;
    if (!r.ok) { item.used = !used; render(); toast(r.error || "Couldn't update the offer", { kind: "error" }); return; }
    if (used) { toast(`${item.merchant} offer marked used`, { undo: () => markOffer(id, false) }); loadSite(true); }
}

const actions = {
    async signin() {
        state.waitingForSignIn = true;
        render();
        const params = new URLSearchParams({ source: "extension", extId: chrome.runtime.id });
        await openUrl(`${base()}/login.html?${params}`);
    },
    async "open-link"(el, event) { event.preventDefault(); await openUrl(el.href); },
    tab(el) { state.tab = el.dataset.tab; render(); },
    "toggle-card"(el) {
        const id = el.dataset.id;
        if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
        el.closest(".row-wrap").classList.toggle("open", state.open.has(id));
        el.setAttribute("aria-expanded", String(state.open.has(id)));
    },
    async update(el) {
        const card = cardById(el.dataset.id);
        const live = state.session && state.session.cardId === card.id && ["opening", "awaiting-login", "watching"].includes(state.session.status);
        if (live && state.session.tabId) {
            try { await chrome.tabs.update(state.session.tabId, { active: true }); return; } catch { /* tab closed: start again */ }
        }
        setRowState(card.id, "syncing", `Opening ${card.issuer}…`);
        const r = await send({ type: "startCapture", card, mode: "auto" });
        if (!r.ok) setRowState(card.id, "error", r.error || "Couldn't start the sync");
        else state.rowState.delete(card.id);
    },
    async "sync-offers"(el) {
        const card = cardById(el.dataset.id);
        setRowState(card.id, "syncing", `Opening ${card.issuer} offers…`);
        const r = await send({ type: "syncOffers", card });
        if (handleSignedOut(r)) return;
        if (!r.ok) return setRowState(card.id, "error", r.error || "Couldn't sync offers");
        setRowState(card.id, "success", `${r.created || 0} new offers, ${r.updated || 0} updated`);
        loadOffers();
    },
    async "read-tab"(el) {
        const card = cardById(el.dataset.id);
        const tab = await activeTab();
        if (!tab?.id) return setRowState(card.id, "error", "No tab open");
        setRowState(card.id, "syncing", "Reading this tab…");
        const r = await send({ type: "syncFromActiveTab", card, tabId: tab.id });
        if (handleSignedOut(r)) return;
        if (!r.ok) return setRowState(card.id, "error", r.error || "Couldn't read this tab");
        if (r.kind === "offers") { setRowState(card.id, "success", `${r.created || 0} new offers, ${r.updated || 0} updated`); loadOffers(); return; }
        setRowState(card.id, "success", r.noop ? `Already at ${Number(r.target).toLocaleString()}` : `${Number(r.current).toLocaleString()} → ${Number(r.target).toLocaleString()}`);
        loadCards({ fresh: true });
    },
    async pick(el) {
        const card = cardById(el.dataset.id);
        const tab = await activeTab();
        if (!tab?.id || !/^https?:/.test(tab.url || "")) return setRowState(card.id, "error", "Open the card's rewards page first");
        const r = await send({ type: "startPickerForCard", card, tabId: tab.id });
        if (!r.ok) setRowState(card.id, "error", r.error || "Couldn't start the picker");
    },
    async "session-pick"() {
        const r = await send({ type: "openPicker" });
        if (!r.ok) toast(r.error || "Couldn't open the picker", { kind: "error" });
    },
    async "dismiss-session"() { await send({ type: "cancelCapture" }); },
    "use-credit"(el) { markCredit(el.dataset.id, true); },
    "use-offer"(el) { markOffer(el.dataset.id, true); },
    async "toggle-autodetect"() { await setState({ autoDetect: !state.settings.autoDetect }); },
    async "toggle-checkout"() {
        if (state.settings.checkoutHints) {
            await setState({ checkoutHints: false });
            chrome.permissions.remove({ origins: CHECKOUT_ORIGINS }).catch(() => {});
            return;
        }
        let granted = false;
        try { granted = await chrome.permissions.request({ origins: CHECKOUT_ORIGINS }); } catch { granted = false; }
        if (!granted) return toast("Site access is needed to show the best card on checkout pages", { kind: "error" });
        await setState({ checkoutHints: true });
        toast("Best card will show on checkout pages");
    },
    async theme(el) { await setState({ theme: el.dataset.value }); },
    async configure(el) {
        const card = cardById(el.dataset.id);
        const r = await send({ type: "startCapture", card, mode: "configure" });
        if (!r.ok) return toast(r.error || "Couldn't open the portal", { kind: "error" });
        state.view = "home";
        render();
    },
    async "reset-spot"(el) { await send({ type: "clearOverride", cardId: el.dataset.id }); toast("Balance spot reset"); },
    async signout() { await send({ type: "logout" }); toast("Signed out"); },
};

app.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || el.tagName === "SELECT" || !actions[el.dataset.act]) return;
    Promise.resolve(actions[el.dataset.act](el, event)).catch((err) => toast(err?.message || "Something went wrong", { kind: "error" }));
});
app.addEventListener("change", (event) => {
    if (event.target.dataset.act === "configure-card") { state.configureCard = event.target.value; render(); }
});

document.getElementById("settings-toggle").addEventListener("click", () => {
    state.view = state.view === "settings" ? "home" : "settings";
    render();
});
document.getElementById("open-dashboard").addEventListener("click", () => openUrl(`${base()}/`));
document.getElementById("brand").addEventListener("click", (event) => { event.preventDefault(); if (state.view !== "signin") openUrl(`${base()}/`); });
window.addEventListener("scroll", () => document.querySelector(".top").classList.toggle("scrolled", window.scrollY > 4), { passive: true });

/* ---------- live updates ---------- */

onChanged((changes) => {
    if (changes.token) {
        state.waitingForSignIn = false;
        if (changes.token.newValue) {
            Object.assign(state, { view: "home", cards: null, credits: null, offers: null, advice: null, siteUrl: "" });
            getState(["user", "apiBase"]).then(({ user, apiBase }) => { state.user = user; state.apiBase = apiBase; render(); });
            toast("Signed in");
            loadAll();
        } else {
            Object.assign(state, { view: "signin", cards: null, credits: null, offers: null, advice: null, session: null });
        }
        render();
        return;
    }
    if (changes.captureSession) {
        const next = changes.captureSession.newValue || null;
        const prev = state.session;
        state.session = next;
        if (next?.cardId) state.rowState.delete(next.cardId);
        if (next?.status === "synced" && prev?.status !== "synced") {
            if (next.kind === "offers") loadOffers(); else loadCards({ fresh: true });
        }
    }
    if (changes.theme) { state.settings.theme = changes.theme.newValue || "system"; applyTheme(state.settings.theme); }
    if (changes.autoDetect) state.settings.autoDetect = changes.autoDetect.newValue !== false;
    if (changes.checkoutHints) state.settings.checkoutHints = Boolean(changes.checkoutHints.newValue);
    if (changes.portalOverrides) state.overrides = changes.portalOverrides.newValue || {};
    if (changes.apiBase) state.apiBase = changes.apiBase.newValue || PRODUCTION;
    if (state.view !== "loading") render();
});

chrome.tabs.onActivated.addListener(() => loadSite());
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.status === "complete" || info.url)) loadSite(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view === "home") { loadSite(true); loadCredits(); loadOffers(); } });

/* ---------- start ---------- */

(async () => {
    const s = await getState(["token", "user", "apiBase", "captureSession", "portalOverrides", "autoDetect", "checkoutHints", "theme", "cardsCache"]);
    applyTheme(s.theme);
    Object.assign(state, {
        user: s.user,
        apiBase: s.apiBase,
        session: s.captureSession,
        overrides: s.portalOverrides || {},
        settings: { autoDetect: s.autoDetect !== false, checkoutHints: Boolean(s.checkoutHints), theme: s.theme || "system" },
        cards: Array.isArray(s.cardsCache) ? s.cardsCache : null, // paint right away, refresh below
    });
    if (!s.token) { state.view = "signin"; render(); return; }
    state.view = "home";
    render();
    loadAll();
})();
