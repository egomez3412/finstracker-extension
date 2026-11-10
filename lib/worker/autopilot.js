// Autopilot: for each card, update everything from the issuer's site.
//   1. Balance (and new rewards activity), in the tab autopilot runs in
//   2. Offers: added to the card and saved      } at the same time, each in its own background tab
//   3. Benefits: credits the issuer shows as used } next to it (by hand), or one after another (daily run)
// It starts from whatever page is open (home, statements…), follows the site's links to each page,
// and remembers where it found them. No step waits forever: a step that finds nothing moves on.
// Cards run one after another: a site shows one selected card at a time, so two cards can't be
// worked on at once. A board on the portal page (content/progress.js) shows every activity.
// By hand it waits for sign-in and for "Is this your balance?"; the daily run, in a background tab
// while the user is signed in to the card's site, never waits for anyone.
import { getState, setState } from "../storage.js";
import { cards as loadCards } from "./account.js";
import { syncBenefits } from "./benefits-sync.js";
import { cancelCapture, fmtValue, startCapture } from "./capture.js";
import { syncOffersForCard } from "./offers-sync.js";
import { notify } from "./tabs.js";
import { distinctWords } from "../programs.js";
import { portalForCard } from "./sites.js";

const DAILY_MS = 20 * 60 * 60 * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let stopRequested = false;
let boardTab = null; // the tab that shows the board
const sideTabs = new Set(); // background tabs for offers and benefits

async function progress(patch) {
    const { autopilotRun } = await getState(["autopilotRun"]);
    await setState({ autopilotRun: autopilotRun ? { ...autopilotRun, ...patch } : null });
}

/** Draw the board on the portal page. Never throws. */
export async function showBoard(tabId, board) {
    if (!tabId || !board) return;
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content/progress.js"] });
        await chrome.scripting.executeScript({ target: { tabId }, func: (b) => window.__finsBoard?.show(b), args: [board] });
    } catch { /* page loading or restricted */ }
}

/** After the board's page reloads (balance step, card switch), draw it again. */
export async function redrawBoard(tabId) {
    const { autopilotRun } = await getState(["autopilotRun"]);
    if (autopilotRun?.board && autopilotRun.boardTab === tabId) await showBoard(tabId, autopilotRun.board);
}

/** Update one activity on the board and redraw it. */
async function step(cardIndex, stepName, state, text) {
    const { autopilotRun } = await getState(["autopilotRun"]);
    if (!autopilotRun?.board) return;
    const board = structuredClone(autopilotRun.board);
    board.cards.forEach((c, i) => { c.current = i === cardIndex && board.running; });
    const s = board.cards[cardIndex]?.steps.find((x) => x.name === stepName);
    if (s) Object.assign(s, { state, text: text || "" });
    await setState({ autopilotRun: { ...autopilotRun, board } });
    await showBoard(boardTab, board);
}

/** A board step from a sync's progress (status → board state). */
const fromStatus = (patch) => {
    if (patch.status === "synced") return ["done", patch.statusLabel];
    if (patch.status === "error") return [/skipped/i.test(patch.lastError || "") ? "skipped" : "error", patch.lastError];
    if (patch.status === "awaiting-login") return ["busy", patch.statusLabel || "Waiting for sign-in"];
    return ["busy", patch.statusLabel];
};

/**
 * Wait for the points sync to finish (or to need the user), mirroring it on the board. Signing in
 * may take up to `ms`; looking for the balance, or waiting for an OK, at most `lookMs` once signed in,
 * so offers and benefits are never held up.
 */
async function waitForBalance(cardId, ms, onChange, lookMs = 90 * 1000) {
    const end = Date.now() + ms;
    let last = "", lookingSince = null;
    while (Date.now() < end && !stopRequested) {
        const { captureSession: s } = await getState(["captureSession"]);
        if (!s || s.cardId !== cardId || s.kind !== "points") return { status: "cancelled" };
        const line = `${s.status}|${s.statusLabel}|${s.lastError || ""}`;
        if (line !== last) { last = line; await onChange(s); }
        if (["synced", "configured", "error"].includes(s.status)) return s;
        if (s.status === "awaiting-login") lookingSince = null;
        else if (lookingSince == null) lookingSince = Date.now();
        else if (Date.now() - lookingSince > lookMs) {
            return s.status === "confirm" ? s : { ...s, status: "error", lastError: s.lastError || "Couldn't find the balance in time" };
        }
        await pause(800);
    }
    const { captureSession: s } = await getState(["captureSession"]);
    return s?.cardId === cardId ? s : { status: "cancelled" };
}

/**
 * A background tab next to the portal tab, for offers or benefits: same window, full width (so the
 * site shows its desktop pages), same sign-in. The user stays on the portal tab.
 */
async function sideTab(mainTabId) {
    let main = null;
    try { main = await chrome.tabs.get(mainTabId); } catch { /* closed */ }
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, ...(main ? { windowId: main.windowId, index: main.index + 1, openerTabId: main.id } : {}) });
    sideTabs.add(tab.id);
    return tab;
}
async function closeTab(id) {
    sideTabs.delete(id);
    try { await chrome.tabs.remove(id); } catch { /* closed by the user */ }
}

export const isRunning = async () => Boolean((await getState(["autopilotRun"])).autopilotRun?.running);

export async function stopAutopilot() {
    stopRequested = true;
    for (const id of [...sideTabs]) closeTab(id);
    return cancelCapture();
}

/** Turn a card's daily autopilot on or off. */
export async function setAutopilot(cardId, on) {
    const { autopilot } = await getState(["autopilot"]);
    await setState({ autopilot: { ...(autopilot || {}), [cardId]: { ...(autopilot?.[cardId] || {}), on: Boolean(on) } } });
    return { ok: true };
}

/** Cards that share a site: same first match pattern of their portal. */
async function siteKey(card) {
    const portal = await portalForCard(card);
    return [].concat(portal?.matchUrl || [])[0] || `card:${card.id}`;
}

/**
 * Run autopilot for these cards (ids). tabId: run in that tab (the portal the user is on);
 * otherwise reuse or open one (a background tab for the daily run). firstId: the card on screen.
 */
export async function runAutopilot(cardIds, { background = false, tabId = null, firstId = null } = {}) {
    if (await isRunning()) return { ok: false, error: "Autopilot is already running" };
    const all = await loadCards({ fresh: true });
    const cards = (cardIds?.length ? cardIds.map((id) => all.find((c) => c.id === id)).filter(Boolean) : all)
        .sort((a, b) => (b.id === firstId) - (a.id === firstId)); // the card on screen first: no switching needed
    if (!cards.length) return { ok: false, error: "No cards to run" };
    stopRequested = false;
    const useWindows = !background; // by hand: offers and benefits in their own windows, at the same time
    const board = {
        running: true,
        title: `Autopilot · ${cards.length} ${cards.length === 1 ? "card" : "cards"}`,
        cards: cards.map((c) => ({ name: c.displayName, current: false, steps: ["Balance", "Offers", "Benefits"].map((name) => ({ name, state: "waiting", text: "" })) })),
    };
    let workTab = tabId || (background ? (await chrome.tabs.create({ url: "about:blank", active: false })).id : null);
    boardTab = background ? null : workTab;
    await setState({ autopilotRun: { running: true, background, total: cards.length, index: 0, cardName: cards[0].displayName, step: "Starting", startedAt: Date.now(), board, boardTab } });
    await showBoard(boardTab, board);
    const summary = [];
    // Which cards share a site, and the words that tell them apart in a card switcher.
    const keys = await Promise.all(cards.map(siteKey));
    const switchFor = (card, index) => {
        const same = cards.filter((c, i) => keys[i] === keys[index]);
        if (same.length < 2) return null;
        const site = same.map((c) => ({ id: c.id, name: c.displayName, words: distinctWords(c, same.filter((o) => o.id !== c.id)) }));
        return { words: site.find((c) => c.id === card.id).words, others: site.filter((c) => c.id !== card.id).map((c) => c.words), cards: site };
    };
    const saveResults = async (card, results) => {
        const { autopilot } = await getState(["autopilot"]);
        await setState({ autopilot: { ...(autopilot || {}), [card.id]: { ...(autopilot?.[card.id] || {}), lastRun: Date.now(), results } } });
    };
    try {
        for (const [index, card] of cards.entries()) {
            if (stopRequested) break;
            const results = {};
            await progress({ index, cardName: card.displayName, step: "Balance" });

            // 1. Balance and activity (after selecting the card when several share the site).
            const switchTo = switchFor(card, index);
            await step(index, "Balance", "busy", "Starting…");
            const started = await startCapture({ card, tabId: workTab, navigate: Boolean(workTab), background, switchTo });
            let selected = false;
            if (started.ok) {
                workTab = workTab || started.session.tabId;
                if (!boardTab && !background) {
                    boardTab = workTab;
                    await progress({ boardTab });
                    await showBoard(boardTab, (await getState(["autopilotRun"])).autopilotRun?.board);
                }
                const s = await waitForBalance(card.id, background ? 3 * 60 * 1000 : 10 * 60 * 1000, (now) => {
                    const [state, text] = now.status === "confirm" ? ["busy", "Waiting for your OK on the page"] : fromStatus(now);
                    return step(index, "Balance", state, text);
                });
                selected = Boolean(s.verified) || (Boolean(s.switchResult?.ok) && !s.wrongCard);
                results.balance = s.status === "synced" ? `Balance ${fmtValue(s.unit, s.lastScrape?.value)}` : s.needsSignIn ? "Sign-in needed" : s.status === "confirm" || s.status === "mismatch" ? "Balance needs your OK" : s.lastError || "Balance not found";
                await step(index, "Balance", s.status === "synced" ? "done" : s.wrongCard ? "skipped" : "error", results.balance.replace(/^Balance /, ""));
                if (s.status !== "synced") await cancelCapture();
                if (s.needsSignIn || s.wrongCard) {
                    // Sign-in needed, or the site kept showing another card: nothing more for this card.
                    const why = s.needsSignIn ? "Sign in first" : `Skipped: ${s.lastError?.match(/shows ([^,]+),/)?.[1] || "another card"} was showing`;
                    if (s.wrongCard) results.balance = why;
                    await step(index, "Offers", "skipped", why);
                    await step(index, "Benefits", "skipped", why);
                    summary.push(`${card.displayName}: ${why}`);
                    await saveResults(card, results);
                    continue;
                }
            } else {
                results.balance = started.error;
                await step(index, "Balance", "error", started.error);
            }
            if (stopRequested) break;

            // 2 and 3. Offers and benefits.
            await progress({ step: "Offers and benefits" });
            const ready = { ...switchTo, ready: selected };
            const job = (name) => ({
                report: (patch) => { const [state, text] = fromStatus(patch); return step(index, name, state, text); },
                stopped: () => stopRequested,
            });
            let offers, benefits;
            if (useWindows && workTab) {
                // Each in its own background tab, at the same time. Same card, same sign-in.
                const [ot, bt] = await Promise.all([sideTab(workTab), sideTab(workTab)]);
                await Promise.all([step(index, "Offers", "busy", "Opening offers in a background tab…"), step(index, "Benefits", "busy", "Opening benefits in a background tab…")]);
                [offers, benefits] = await Promise.all([
                    syncOffersForCard(card, { tabId: ot.id, navigate: true, background: true, switchTo: switchTo && ready, job: job("Offers") }),
                    syncBenefits(card, { tabId: bt.id, navigate: true, background: true, switchTo: switchTo && ready, job: job("Benefits") }),
                ]);
                await Promise.all([closeTab(ot.id), closeTab(bt.id)]);
            } else {
                offers = await syncOffersForCard(card, { tabId: workTab, navigate: true, background, switchTo: switchTo && ready, job: job("Offers") });
                if (!stopRequested) benefits = await syncBenefits(card, { tabId: workTab, navigate: true, background, switchTo: switchTo && ready, job: job("Benefits") });
            }
            results.offers = offers?.ok ? `${offers.added ? `${offers.added} added · ` : ""}${offers.found} offers saved${offers.notAdded ? ` · ${offers.notAdded} not added` : ""}` : offers?.skipped ? "Offers skipped" : offers?.error || "Stopped";
            results.benefits = benefits?.ok ? (benefits.marked.length ? `Marked used: ${benefits.marked.join(", ")}` : `${benefits.read} read · nothing new used`) : benefits?.skipped ? "Benefits skipped" : benefits?.error || "Stopped";
            await step(index, "Offers", offers?.ok ? "done" : offers?.skipped ? "skipped" : "error", results.offers);
            await step(index, "Benefits", benefits?.ok ? "done" : benefits?.skipped ? "skipped" : "error", results.benefits);
            await saveResults(card, results);
            summary.push(`${card.displayName}: ${[results.balance, results.offers, results.benefits].filter(Boolean).join(" · ")}`);
        }
    } catch (err) {
        console.warn("[finstracker] autopilot stopped by an error", err);
        await setState({ autopilotError: String(err?.stack || err) });
        summary.push(`Autopilot stopped: ${err?.message || err}`);
    } finally {
        for (const id of [...sideTabs]) await closeTab(id);
        if (background && workTab && !tabId) chrome.tabs.remove(workTab).catch(() => {});
        const { autopilotRun } = await getState(["autopilotRun"]);
        const finalBoard = autopilotRun?.board && { ...autopilotRun.board, running: false, title: stopRequested ? "Autopilot stopped" : `Autopilot done · ${cards.length} ${cards.length === 1 ? "card" : "cards"}`, cards: autopilotRun.board.cards.map((c) => ({ ...c, current: false })) };
        await setState({ autopilotRun: null, captureSession: null, autopilotLastBoard: finalBoard || null });
        if (finalBoard && boardTab) await showBoard(boardTab, finalBoard);
        boardTab = null;
    }
    if (summary.length) notify("Finstracker autopilot", summary.join("\n").slice(0, 400));
    return { ok: true, summary, stopped: stopRequested };
}

/** On a card's site, signed in: run the daily autopilot for cards that have it on and are due. */
export async function maybeRunDaily(cardIds) {
    const { autopilotAuto, autopilot, captureSession } = await getState(["autopilotAuto", "autopilot", "captureSession"]);
    if (!autopilotAuto || captureSession || (await isRunning())) return;
    const due = cardIds.filter((id) => autopilot?.[id]?.on && Date.now() - (autopilot[id].lastRun || 0) > DAILY_MS);
    if (due.length) runAutopilot(due, { background: true }).catch((err) => console.warn("[finstracker] autopilot", err));
}
