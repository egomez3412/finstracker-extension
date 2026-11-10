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
    settings: { autoDetect: true, checkoutHints: false, theme: "system", addOffersToCard: true, recordActivity: true, autopilotAuto: false, launcherOn: true, autoAddCards: true },
    launcherHidden: {}, // sites where the quick tab was hidden
    autopilot: {}, // cardId → { on, lastRun, results }
    page: null, // the open tab: { tabId, url, site, bank, cardIds } (cards linked to its site)
    linking: false, // showing "Which of your cards use this site?"
    autopilotRun: null, // { running, total, index, cardName, step }
    overrides: {},
    pages: {}, // cardId → { url, source } where the balance was found or the user set it
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

const send = (message) => { try { return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: err?.message || "Extension error" })); } catch (err) { return Promise.resolve({ ok: false, error: err?.message || "Extension error" }); } };
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
/** 98,765 for points, $123.45 for cash back. */
const unitValue = (unit, n) => (unit === "cashback" ? `$${Number(n).toFixed(2)}` : Number(n).toLocaleString());

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
    state.linking = false;
    const web = /^https?:/.test(url);
    const [r, p] = await Promise.all([web ? send({ type: "siteAdvice", url }) : null, web ? send({ type: "pageCards", url }) : null]);
    state.advice = r?.ok ? r.advice : null;
    state.page = p?.ok ? { tabId: tab.id, url, site: p.site, bank: p.bank, cardIds: p.cardIds, newCards: [] } : null;
    render();
    // Cards the popup or autopilot already found on this tab that aren't in Finstracker yet.
    if (state.page) {
        const n = await send({ type: "pageNewCards", tabId: tab.id });
        if (n?.ok && state.page?.tabId === tab.id) { state.page.newCards = n.newCards; render(); }
    }
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
    const offers = s.kind === "offers" || s.kind === "benefits";
    const btn = (act, label, primary = false) => `<button type="button" class="${primary ? "btn-primary" : "btn-ghost"} btn-small" data-act="${act}">${label}</button>`;
    let icon, title, sub = "", buttons;
    if (s.status === "synced" || s.status === "configured") {
        icon = '<span class="dot dot-good" aria-hidden="true"></span>';
        title = offers ? s.statusLabel || "Offers saved" : s.status === "configured" ? "Balance spot saved" : `${s.cardName} synced`;
        if (!offers && s.lastScrape?.value != null) sub = unitValue(s.unit, s.lastScrape.value);
        buttons = btn("dismiss-session", "Done");
    } else if (s.status === "confirm" && s.pending) {
        const value = unitValue(s.unit, s.pending.value);
        icon = '<span class="dot" style="background:var(--selection-ink)" aria-hidden="true"></span>';
        title = `Is this your ${s.cardName} balance?`;
        sub = `${value} · highlighted on the page`;
        buttons = btn("confirm-reading", `Use ${value}`, true) + btn("session-pick", "Pick another") + btn("dismiss-session", "Cancel");
    } else if (s.status === "mismatch" && s.mismatch) {
        const kind = s.mismatch.unit === "cashback" ? "cash back" : "points";
        icon = '<span class="dot" style="background:var(--selection-ink)" aria-hidden="true"></span>';
        title = `This page shows ${kind}: ${unitValue(s.mismatch.unit, s.mismatch.value)}`;
        sub = `Finstracker tracks ${s.cardName} in ${s.unit === "cashback" ? "cash back" : "points"}.`;
        buttons = `<button type="button" class="btn-primary btn-small" data-act="status-action" data-value="switch-type">Switch to ${kind}</button>` + btn("session-pick", "Pick the balance") + btn("dismiss-session", "Cancel");
    } else if (s.status === "error") {
        icon = '<span class="dot dot-bad" aria-hidden="true"></span>';
        title = `Couldn't sync ${s.cardName || ""}`;
        sub = s.lastError || "Something went wrong";
        buttons = (offers ? "" : btn("session-pick", "Pick the balance", true) + btn("retry-session", "Try again")) + btn("dismiss-session", "Dismiss");
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
    const ap = state.autopilot[card.id] || {};
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
                <div><dt>Rewards page</dt><dd>${state.pages[card.id] ? esc(hostOf(state.pages[card.id].url)) : "Not saved yet"}</dd></div>
                ${override ? `<div><dt>Balance spot</dt><dd>${override.source === "user-picker" ? "Your pick" : "Learned"}</dd></div>` : ""}
                <div><dt>Daily autopilot</dt><dd><button type="button" class="toggle toggle-inline" role="switch" aria-checked="${Boolean(ap.on)}" aria-label="Daily autopilot for ${esc(card.displayName)}" data-act="toggle-autopilot" data-id="${esc(card.id)}"><span class="toggle-thumb"></span></button></dd></div>
                ${ap.lastRun ? `<div><dt>Last autopilot</dt><dd>${esc(ago(new Date(ap.lastRun).toISOString()))}</dd></div>${Object.entries(ap.results || {}).map(([k, v]) => `<div><dt>${esc(k[0].toUpperCase() + k.slice(1))}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join("")}` : ""}
            </dl>
            <div class="action-row">
                <button type="button" class="btn-primary btn-small" data-act="run-autopilot" data-id="${esc(card.id)}">Run autopilot</button>
                <button type="button" class="btn-ghost btn-small" data-act="update" data-id="${esc(card.id)}">Update ${card.rewardType === "cashback" ? "cash back" : "points"}</button>
                <button type="button" class="btn-ghost btn-small" data-act="sync-offers" data-id="${esc(card.id)}">Sync offers</button>
                <button type="button" class="btn-ghost btn-small" data-act="sync-benefits" data-id="${esc(card.id)}">Sync benefits</button>
                <button type="button" class="btn-ghost btn-small" data-act="read-tab" data-id="${esc(card.id)}">Read this tab</button>
                <button type="button" class="btn-ghost btn-small" data-act="pick" data-id="${esc(card.id)}">Pick the balance</button>
                <button type="button" class="btn-ghost btn-small" data-act="use-tab" data-id="${esc(card.id)}">Use this tab</button>
            </div>
        </div></div></div>
    </li>`;
}

/** Top of Your cards: autopilot for the cards on the site in the open tab, or linking cards to it. */
/** Cards the open site lists that aren't in Finstracker yet, or a button to look for them. */
function newCardsBlock(p) {
    if (!p.bank && !p.cardIds.length) return "";
    if (!p.newCards?.length) return `<div class="action-row"><button type="button" class="btn-ghost btn-small" data-act="find-new" ${state.findingNew ? "disabled" : ""}>${state.findingNew ? "Looking…" : "Find new cards on this site"}</button></div>`;
    return `<div class="row-title">${p.newCards.length === 1 ? "A card here isn't" : `${p.newCards.length} cards here aren't`} in Finstracker yet</div>
        <div class="link-list new-list">${p.newCards.map((c) => `<label class="link-item"><input type="checkbox" value="${esc(c.key)}" checked> ${esc(c.name)}${c.last4 ? ` <span class="row-sub">•••• ${esc(c.last4)}</span>` : ""}</label>`).join("")}</div>
        <div class="action-row"><button type="button" class="btn-primary btn-small" data-act="add-site-cards">Add to Finstracker</button><button type="button" class="btn-ghost btn-small" data-act="ignore-site-cards">Not mine</button></div>`;
}

function pageBlock() {
    const p = state.page;
    if (!p || !state.cards?.length) return "";
    const here = state.cards.filter((c) => p.cardIds.includes(c.id));
    if (state.linking) {
        return `<div class="page-block">
            <div class="row-title">Which of your cards use ${esc(p.site)}?</div>
            <div class="link-list">${state.cards.map((c) => `<label class="link-item"><input type="checkbox" value="${esc(c.id)}" ${p.cardIds.includes(c.id) ? "checked" : ""}> ${esc(c.displayName)}</label>`).join("")}</div>
            <div class="action-row"><button type="button" class="btn-primary btn-small" data-act="link-save" data-value="run">Save and run autopilot</button><button type="button" class="btn-ghost btn-small" data-act="link-save">Save</button><button type="button" class="btn-ghost btn-small" data-act="link-cancel">Cancel</button></div>
        </div>`;
    }
    if (here.length) {
        return `<div class="page-block">
            <div class="row-main"><div class="row-title">On ${esc(p.site)}</div><div class="row-sub">${esc(here.map((c) => c.displayName).join(", "))}</div></div>
            <div class="action-row"><button type="button" class="btn-primary btn-small" data-act="run-autopilot-page" ${state.autopilotRun ? "disabled" : ""}>Run autopilot on this page</button><button type="button" class="btn-ghost btn-small" data-act="link-start">Change cards</button></div>
            ${newCardsBlock(p)}
        </div>`;
    }
    return `<div class="page-block">
        <div class="row-main"><div class="row-title">${p.bank ? `${esc(p.site)} isn't linked to your cards yet` : `No cards linked to ${esc(p.site)}`}</div></div>
        <div class="action-row"><button type="button" class="${p.bank ? "btn-primary" : "btn-ghost"} btn-small" data-act="link-start">Link cards to this site</button></div>
        ${newCardsBlock(p)}
    </div>`;
}

function cardsPanel() {
    const action = headLink(`${base()}/cards`, "All cards");
    if (!state.cards) return panel("Your cards", action, placeholderRows());
    if (!state.cards.length) return panel("Your cards", headLink(`${base()}/cards`, "Add a card"), emptyState("No cards yet"));
    const active = state.session?.cardId;
    const list = [...state.cards].sort((a, b) => (b.id === active) - (a.id === active) || String(a.displayName).localeCompare(String(b.displayName)));
    // All cards at the bottom, after the list.
    const foot = `<div class="panel-foot-actions"><button type="button" class="btn-ghost btn-small" data-act="run-autopilot" ${state.autopilotRun ? "disabled" : ""}>Run autopilot for all cards</button><a class="btn-ghost btn-small" href="${esc(base())}/cards" data-act="open-link">Add cards</a></div>`;
    return panel("Your cards", action, `${pageBlock()}<div class="panel-body"><ul class="rows">${list.map(cardRow).join("")}</ul></div>${foot}`);
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

function autopilotStrip() {
    const run = state.autopilotRun;
    if (!run) return "";
    return `<section class="panel status" aria-live="polite"><div class="panel-body">
        <div class="row"><span class="spinner" aria-hidden="true"></span><div class="row-main"><div class="row-title">Autopilot · ${esc(run.cardName || "")}</div><div class="row-sub">${esc(`Card ${run.index + 1} of ${run.total} · ${run.step}${run.background ? " · in a background tab" : ""}`)}</div></div></div>
        <div class="action-row"><button type="button" class="btn-ghost btn-small" data-act="stop-autopilot">Stop</button></div>
    </div></section>`;
}

function homeView() {
    const body = state.tab === "credits" ? creditsPanel() : state.tab === "offers" ? offersPanel() : cardsPanel();
    return `<div class="view" data-view="home">${autopilotStrip()}${statusStrip()}${siteBlock()}${statsBlock()}${tabsBlock()}${body}</div>`;
}

function settingsView() {
    const s = state.settings;
    const toggle = (act, on, label, key = "") => `<button type="button" class="toggle" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="${act}"${key ? ` data-value="${key}"` : ""}><span class="toggle-thumb"></span></button>`;
    const theme = (value, label) => `<button type="button" role="tab" aria-selected="${s.theme === value}" data-act="theme" data-value="${value}">${label}</button>`;
    const cards = state.cards || [];
    const picked = cards.find((c) => c.id === state.configureCard);
    const line = (label, control) => `<li class="row"><div class="row-main"><div class="row-title">${esc(label)}</div></div>${control}</li>`;
    return `<div class="view" data-view="settings">
        <h1 class="page-title">Settings</h1>
        ${panel("Sync", "", `<div class="panel-body"><ul class="rows">
            ${line("Offer to sync on card portals", toggle("toggle-autodetect", s.autoDetect, "Offer to sync on card portals"))}
            ${line("Quick tab on card sites", toggle("toggle-setting", s.launcherOn, "Quick tab on card sites", "launcherOn"))}
            ${Object.keys(state.launcherHidden).length ? `<li class="row"><div class="row-main"><div class="row-title">Quick tab hidden on ${Object.keys(state.launcherHidden).length} ${Object.keys(state.launcherHidden).length === 1 ? "site" : "sites"}</div><div class="row-sub">${esc(Object.keys(state.launcherHidden).map(hostOf).join(", "))}</div></div><button type="button" class="btn-ghost btn-small" data-act="unhide-launcher">Show again</button></li>` : ""}
            ${line("Best card at checkout", toggle("toggle-checkout", s.checkoutHints, "Best card at checkout"))}
            ${line("Add offers to my cards", toggle("toggle-setting", s.addOffersToCard, "Add offers to my cards", "addOffersToCard"))}
            ${line("Record points activity", toggle("toggle-setting", s.recordActivity, "Record points activity", "recordActivity"))}
            ${line("Daily autopilot when signed in", toggle("toggle-setting", s.autopilotAuto, "Daily autopilot when signed in", "autopilotAuto"))}
            ${line("Autopilot adds new cards it finds", toggle("toggle-setting", s.autoAddCards, "Autopilot adds new cards it finds", "autoAddCards"))}
        </ul></div>`)}
        ${panel("Appearance", "", `<div class="panel-body"><ul class="rows">${line("Theme", `<div class="seg" role="tablist" aria-label="Theme">${theme("system", "System")}${theme("light", "Light")}${theme("dark", "Dark")}</div>`)}</ul></div>`)}
        ${panel("Rewards pages", "", `<div class="panel-body form-stack">
            <select class="select" data-act="configure-card" aria-label="Card">
                <option value="">Choose a card</option>
                ${cards.map((c) => `<option value="${esc(c.id)}" ${c.id === state.configureCard ? "selected" : ""}>${esc(c.displayName)} · ${esc(c.issuer)}</option>`).join("")}
            </select>
            ${picked ? `${state.pages[picked.id] ? `<dl class="summary-list"><div><dt>Saved page</dt><dd>${esc(hostOf(state.pages[picked.id].url))}</dd></div></dl>` : ""}
            <div class="action-row"><button type="button" class="btn-primary btn-small" data-act="configure" data-id="${esc(picked.id)}">Open portal and pick</button><button type="button" class="btn-ghost btn-small" data-act="use-tab" data-id="${esc(picked.id)}">Use current tab</button>${state.overrides[picked.id] || state.pages[picked.id] ? `<button type="button" class="btn-ghost btn-small" data-act="reset-spot" data-id="${esc(picked.id)}">Reset</button>` : ""}</div>` : ""}
        </div>`)}
        ${panel("Account", "", `<div class="panel-body"><ul class="rows"><li class="row"><div class="row-main"><div class="row-title">${esc(state.user?.username || state.user?.email || "Signed in")}</div>${state.apiBase !== PRODUCTION ? `<div class="row-sub">${esc(state.apiBase)}</div>` : ""}</div><button type="button" class="btn-ghost btn-small btn-danger-text" data-act="signout">Sign out</button></li>
            ${state.confirmReset
                ? `<li class="row row-confirm"><div class="row-main"><div class="row-title">Delete all ${(state.cards || []).length} cards?</div><div class="row-sub">Their offers and credits on Finstracker go too, and the extension forgets what it learned. This can't be undone.</div></div><div class="action-row"><button type="button" class="btn-ghost btn-small" data-act="reset-cancel">Cancel</button><button type="button" class="btn-primary btn-small btn-danger" data-act="reset-confirm">Delete everything</button></div></li>`
                : `<li class="row"><div class="row-main"><div class="row-title">Start over</div><div class="row-sub">Delete every card, offer and credit on this account</div></div><button type="button" class="btn-ghost btn-small btn-danger-text" data-act="reset-ask">Delete all</button></li>`}
        </ul></div>`)}
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

/** "https://global.americanexpress.com/x" → "americanexpress.com" */
const hostOf = (url) => { try { return new URL(url).hostname.split(".").slice(-2).join("."); } catch { return ""; } };

/** Ask for access to the open site when it is not one of the built-in issuer and program sites. */
async function ensureSiteAccess(url) {
    let origins;
    try { origins = [`${new URL(url).origin}/*`]; } catch { return false; }
    try {
        if (await chrome.permissions.contains({ origins })) return true;
        return await chrome.permissions.request({ origins });
    } catch {
        return false;
    }
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
        else { state.rowState.delete(card.id); render(); }
    },
    async "run-autopilot"(el) {
        const ids = el.dataset.id ? [el.dataset.id] : Object.entries(state.autopilot).filter(([, v]) => v.on).map(([id]) => id);
        const r = await send({ type: "runAutopilot", cardIds: ids });
        if (!r.ok) toast(r.error || "Couldn't start autopilot", { kind: "error" });
        else toast(ids.length === 1 ? "Autopilot started" : ids.length ? `Autopilot started for ${ids.length} cards` : "Autopilot started for all cards");
    },
    async "run-autopilot-page"() {
        const p = state.page;
        if (!p?.cardIds.length) return;
        if (!(await ensureSiteAccess(p.url))) return toast(`Allow access to ${p.site} first`, { kind: "error" });
        const r = await send({ type: "runAutopilot", cardIds: p.cardIds, tabId: p.tabId });
        if (!r.ok) toast(r.error || "Couldn't start autopilot", { kind: "error" });
        else { toast(`Autopilot started on ${p.site}`); try { await chrome.tabs.update(p.tabId, { active: true }); } catch { /* tab closed */ } }
    },
    async "find-new"() {
        const p = state.page;
        if (!p) return;
        if (!(await ensureSiteAccess(p.url))) return toast(`Allow access to ${p.site} first`, { kind: "error" });
        state.findingNew = true; render();
        const r = await send({ type: "pageNewCards", tabId: p.tabId, find: true });
        state.findingNew = false;
        if (r?.ok && state.page === p) p.newCards = r.newCards;
        render();
        if (r?.ok && !r.newCards.length) toast(`No new cards on ${p.site}. Sign in there first if you haven't.`);
        else if (!r?.ok) toast(r?.error || "Couldn't read the page", { kind: "error" });
    },
    async "add-site-cards"() {
        const p = state.page;
        const keys = [...app.querySelectorAll(".new-list input:checked")].map((i) => i.value);
        if (!keys.length) return toast("Tick at least one card", { kind: "error" });
        const r = await send({ type: "addSiteCards", tabId: p.tabId, keys });
        if (!r?.ok) return toast(r?.error || "Couldn't add the cards", { kind: "error" });
        toast(`Added ${r.added.map((c) => c.displayName).join(", ")}${r.failed?.length ? ` · couldn't add ${r.failed.join(", ")}` : ""}`);
        await loadCards({ fresh: true });
        loadSite(true);
    },
    async "ignore-site-cards"() {
        const p = state.page;
        const keys = (p?.newCards || []).map((c) => c.key);
        await send({ type: "ignoreSiteCards", tabId: p.tabId, keys });
        p.newCards = [];
        render();
    },
    "link-start"() { state.linking = true; render(); },
    "link-cancel"() { state.linking = false; render(); },
    async "link-save"(el) {
        const p = state.page;
        const ids = [...app.querySelectorAll(".link-list input:checked")].map((i) => i.value);
        if (!ids.length) return toast("Tick at least one card", { kind: "error" });
        if (!(await ensureSiteAccess(p.url))) return toast(`Allow access to ${p.site} first`, { kind: "error" });
        const r = await send({ type: "linkCardsToSite", tabId: p.tabId, cardIds: ids, run: el.dataset.value === "run" });
        if (!r.ok) return toast(r.error || "Couldn't save", { kind: "error" });
        toast(el.dataset.value === "run" ? `Autopilot started on ${p.site}` : `${ids.length} ${ids.length === 1 ? "card" : "cards"} linked to ${p.site}`);
        loadSite(true);
    },
    async "stop-autopilot"() { await send({ type: "stopAutopilot" }); toast("Autopilot stopped"); },
    async "toggle-autopilot"(el) {
        const on = !state.autopilot[el.dataset.id]?.on;
        await send({ type: "setAutopilot", cardId: el.dataset.id, on });
        if (on && !state.settings.autopilotAuto) toast("Turn on Daily autopilot in Settings to run it by itself");
    },
    async "unhide-launcher"() { await setState({ launcherHidden: {} }); toast("The quick tab will show on those sites again"); },
    async "toggle-setting"(el) {
        const key = el.dataset.value;
        await setState({ [key]: !state.settings[key] });
    },
    async "sync-benefits"(el) {
        const card = cardById(el.dataset.id);
        setRowState(card.id, "syncing", `Opening ${card.displayName} benefits…`);
        const r = await send({ type: "syncBenefits", card });
        if (handleSignedOut(r)) return;
        if (!r.ok) return setRowState(card.id, "error", r.error || "Couldn't check benefits");
        setRowState(card.id, "success", r.marked.length ? `Marked used: ${r.marked.join(", ")}` : `${r.read} benefits checked, nothing new used`);
        loadCredits();
    },
    async "sync-offers"(el) {
        const card = cardById(el.dataset.id);
        setRowState(card.id, "syncing", `Opening ${card.issuer} offers…`);
        const r = await send({ type: "syncOffers", card });
        if (handleSignedOut(r)) return;
        if (!r.ok) return setRowState(card.id, "error", r.error || "Couldn't sync offers");
        setRowState(card.id, "success", `${r.added ? `${r.added} added to the card · ` : ""}${r.created || 0} new, ${r.updated || 0} updated`);
        loadOffers();
    },
    async "read-tab"(el) {
        const card = cardById(el.dataset.id);
        const tab = await activeTab();
        if (!tab?.id || !/^https?:/.test(tab.url || "")) return setRowState(card.id, "error", "Open the card's rewards page first");
        if (!(await ensureSiteAccess(tab.url))) return setRowState(card.id, "error", `Allow access to ${hostOf(tab.url)} to read it`);
        setRowState(card.id, "syncing", "Reading this tab…");
        const r = await send({ type: "syncFromActiveTab", card, tabId: tab.id });
        if (handleSignedOut(r)) return;
        if (!r.ok) return setRowState(card.id, "error", r.error || "Couldn't read this tab");
        if (r.kind === "offers") { setRowState(card.id, "success", `${r.created || 0} new offers, ${r.updated || 0} updated`); loadOffers(); return; }
        state.rowState.delete(card.id); // the status area above follows the read from here
        render();
    },
    async pick(el) {
        const card = cardById(el.dataset.id);
        const tab = await activeTab();
        setRowState(card.id, "syncing", "Opening the picker…");
        let r = await send({ type: "pickBalance", card, tabId: tab?.id });
        if (!r.ok && /access|cannot|permission/i.test(r.error || "") && tab?.url && (await ensureSiteAccess(tab.url))) {
            r = await send({ type: "pickBalance", card, tabId: tab.id });
        }
        if (!r.ok) return setRowState(card.id, "error", r.error || "Couldn't open the picker");
        state.rowState.delete(card.id); // the status area follows the picking from here
        render();
    },
    async "use-tab"(el) {
        const card = cardById(el.dataset.id);
        const tab = await activeTab();
        if (!tab?.id || !/^https?:/.test(tab.url || "")) return toast("Open the card's rewards page in a tab first", { kind: "error" });
        if (!(await ensureSiteAccess(tab.url))) return toast(`Allow access to ${hostOf(tab.url)} to use it`, { kind: "error" });
        const r = await send({ type: "setRewardsPage", cardId: card.id, url: tab.url });
        toast(r.ok ? `${card.displayName} will sync from ${hostOf(tab.url)}` : r.error || "Couldn't save the page", { kind: r.ok ? "" : "error" });
    },
    async "session-pick"() {
        const r = await send({ type: "openPicker" });
        if (!r.ok) toast(r.error || "Couldn't open the picker", { kind: "error" });
    },
    async "dismiss-session"() { await send({ type: "cancelCapture" }); },
    async "confirm-reading"() {
        const r = await send({ type: "confirmReading" });
        if (!r.ok) toast(r.error || "Couldn't save the balance", { kind: "error" });
    },
    async "retry-session"() { await send({ type: "retryCapture" }); },
    async "status-action"(el) {
        const r = await send({ type: "statusAction", action: el.dataset.value });
        if (r && !r.ok && r.error) toast(r.error, { kind: "error" });
    },
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
    async "reset-spot"(el) { await send({ type: "clearOverride", cardId: el.dataset.id }); toast("Rewards page and balance spot reset"); },
    async signout() { await send({ type: "logout" }); toast("Signed out"); },
    "reset-ask"() { state.confirmReset = true; render(); },
    "reset-cancel"() { state.confirmReset = false; render(); },
    async "reset-confirm"(el) {
        el.disabled = true; el.textContent = "Deleting…";
        const r = await send({ type: "resetAccount" });
        state.confirmReset = false;
        if (r?.signedOut) return toast("Sign in first", { kind: "error" });
        toast(r?.ok ? `Deleted ${r.cards} cards, ${r.offers} offers and ${r.credits} credits` : r?.error || "Couldn't delete everything", { kind: r?.ok ? "" : "error" });
        state.view = "home";
        await Promise.all([loadCards({ fresh: true }), loadCredits(), loadOffers()]);
    },
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
    for (const key of ["addOffersToCard", "recordActivity", "launcherOn", "autoAddCards"]) if (changes[key]) state.settings[key] = changes[key].newValue !== false;
    if (changes.launcherHidden) state.launcherHidden = changes.launcherHidden.newValue || {};
    if (changes.autopilotAuto) state.settings.autopilotAuto = Boolean(changes.autopilotAuto.newValue);
    if (changes.autopilot) state.autopilot = changes.autopilot.newValue || {};
    if (changes.autopilotRun) {
        const was = state.autopilotRun;
        state.autopilotRun = changes.autopilotRun.newValue || null;
        if (was && !state.autopilotRun) { loadCards({ fresh: true }); loadCredits(); loadOffers(); }
    }
    if (changes.portalOverrides) state.overrides = changes.portalOverrides.newValue || {};
    if (changes.rewardsPages) state.pages = changes.rewardsPages.newValue || {};
    if (changes.apiBase) state.apiBase = changes.apiBase.newValue || PRODUCTION;
    if (state.view !== "loading") render();
});

chrome.tabs.onActivated.addListener(() => loadSite());
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.status === "complete" || info.url)) loadSite(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view === "home") { loadSite(true); loadCredits(); loadOffers(); } });

/* ---------- start ---------- */

(async () => {
    const s = await getState(["token", "user", "apiBase", "captureSession", "portalOverrides", "rewardsPages", "autoDetect", "checkoutHints", "theme", "cardsCache", "addOffersToCard", "autoAddCards", "recordActivity", "autopilotAuto", "autopilot", "autopilotRun", "launcherOn", "launcherHidden"]);
    applyTheme(s.theme);
    Object.assign(state, {
        user: s.user,
        apiBase: s.apiBase,
        session: s.captureSession,
        overrides: s.portalOverrides || {},
        pages: s.rewardsPages || {},
        settings: { autoDetect: s.autoDetect !== false, checkoutHints: Boolean(s.checkoutHints), theme: s.theme || "system", addOffersToCard: s.addOffersToCard !== false, recordActivity: s.recordActivity !== false, autopilotAuto: Boolean(s.autopilotAuto), launcherOn: s.launcherOn !== false, autoAddCards: s.autoAddCards !== false },
        launcherHidden: s.launcherHidden || {},
        autopilot: s.autopilot || {},
        autopilotRun: s.autopilotRun || null,
        cards: Array.isArray(s.cardsCache) ? s.cardsCache : null, // paint right away, refresh below
    });
    if (!s.token) { state.view = "signin"; render(); return; }
    state.view = "home";
    render();
    loadAll();
})();
