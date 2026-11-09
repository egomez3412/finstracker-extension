// Autopilot: for each card, go through the issuer's pages in one tab and update everything.
//   1. Balance (and new rewards activity) from the rewards page
//   2. Offers: add them to the card, save them to Finstracker
//   3. Benefits: mark credits the issuer shows as used
// Run by hand (a visible tab; it waits for sign-in and for "Is this your balance?") or once a day
// in a background tab while the user is signed in to the card's site (never waits for anyone).
import { getState, setState } from "../storage.js";
import { cards as loadCards } from "./account.js";
import { syncBenefits } from "./benefits-sync.js";
import { cancelCapture, fmtValue, startCapture } from "./capture.js";
import { syncOffersForCard } from "./offers-sync.js";
import { notify, pageStatus } from "./tabs.js";
import { balanceHints } from "../programs.js";
import { portalForCard } from "./sites.js";

const DAILY_MS = 20 * 60 * 60 * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let stopRequested = false;

async function progress(patch) {
    const { autopilotRun } = await getState(["autopilotRun"]);
    await setState({ autopilotRun: autopilotRun ? { ...autopilotRun, ...patch } : null });
}

/** Wait for the points sync to finish (or to need the user). */
async function waitForBalance(cardId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopRequested) {
        const { captureSession: s } = await getState(["captureSession"]);
        if (!s || s.cardId !== cardId || s.kind !== "points") return { status: "cancelled" };
        if (["synced", "configured", "error"].includes(s.status)) return s;
        await pause(1000);
    }
    const { captureSession: s } = await getState(["captureSession"]);
    return s?.cardId === cardId ? s : { status: "cancelled" };
}

export const isRunning = async () => Boolean((await getState(["autopilotRun"])).autopilotRun?.running);

export function stopAutopilot() {
    stopRequested = true;
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
 * Run autopilot for these cards (ids), one after another. tabId: run in that tab (the portal the
 * user is on); otherwise reuse or open one (or a background tab when background is set).
 * Cards that share a site are selected in the site's card switcher before each step.
 */
export async function runAutopilot(cardIds, { background = false, tabId = null } = {}) {
    if (await isRunning()) return { ok: false, error: "Autopilot is already running" };
    const all = await loadCards({ fresh: true });
    const cards = (cardIds?.length ? cardIds.map((id) => all.find((c) => c.id === id)).filter(Boolean) : all);
    if (!cards.length) return { ok: false, error: "No cards to run" };
    stopRequested = false;
    await setState({ autopilotRun: { running: true, background, total: cards.length, index: 0, cardName: cards[0].displayName, step: "Starting", startedAt: Date.now() } });
    let workTab = tabId || (background ? (await chrome.tabs.create({ url: "about:blank", active: false })).id : null);
    const summary = [];
    const rows = []; // [card, one-line result] for the page's summary note
    // Which cards share a site, and the words that tell them apart in a card switcher.
    const keys = await Promise.all(cards.map(siteKey));
    const wordsOf = (c) => balanceHints(c).cardWords;
    const switchFor = (card, index) => {
        const siblings = cards.filter((c, i) => i !== index && keys[i] === keys[index]);
        return siblings.length ? { words: wordsOf(card), others: siblings.map(wordsOf).filter((w) => w.length) } : null;
    };
    try {
        for (const [index, card] of cards.entries()) {
            if (stopRequested) break;
            const results = {};
            await progress({ index, cardName: card.displayName, step: "Balance" });

            // 1. Balance and activity (after selecting the card when several share the site).
            const switchTo = switchFor(card, index);
            const started = await startCapture({ card, tabId: workTab, navigate: Boolean(workTab), background, switchTo });
            let selected = false;
            if (started.ok) {
                workTab = workTab || started.session.tabId;
                const s = await waitForBalance(card.id, background ? 3 * 60 * 1000 : 10 * 60 * 1000);
                selected = Boolean(s.switchResult?.ok);
                results.balance = s.status === "synced" ? `Balance ${fmtValue(s.unit, s.lastScrape?.value)}` : s.needsSignIn ? "Sign-in needed" : s.status === "confirm" || s.status === "mismatch" ? "Balance needs your OK" : s.lastError || "Balance not found";
                if (s.status !== "synced") await cancelCapture();
                if (s.needsSignIn) { summary.push(`${card.displayName}: sign in to sync`); continue; }
            } else {
                results.balance = started.error;
            }
            if (stopRequested) break;

            // 2. Offers (only where the issuer has an offers page).
            await progress({ step: "Offers" });
            const r = await syncOffersForCard(card, { tabId: workTab, navigate: true, background, switchTo: switchTo && { ...switchTo, ready: selected } });
            results.offers = r.ok ? `${r.added ? `${r.added} added · ` : ""}${r.found} offers saved` : r.skipped ? "Offers skipped: card not in the site's card list" : r.error;
            if (stopRequested) break;

            // 3. Benefits.
            await progress({ step: "Benefits" });
            const b = await syncBenefits(card, { tabId: workTab, navigate: true, background, switchTo: switchTo && { ...switchTo, ready: selected } });
            results.benefits = b.ok ? (b.marked.length ? `Marked used: ${b.marked.join(", ")}` : "No new credits used") : b.skipped ? "Benefits skipped" : b.error;

            const { autopilot } = await getState(["autopilot"]);
            await setState({ autopilot: { ...(autopilot || {}), [card.id]: { ...(autopilot?.[card.id] || {}), lastRun: Date.now(), results } } });
            summary.push(`${card.displayName}: ${[results.balance, results.offers, results.benefits].filter(Boolean).join(" · ")}`);
            rows.push([card.displayName, [results.balance?.replace(/^Balance /, ""), results.offers, results.benefits].filter(Boolean).join(" · ")]);
        }
    } finally {
        if (background && workTab && !tabId) chrome.tabs.remove(workTab).catch(() => {});
        await setState({ autopilotRun: null, captureSession: null });
    }
    if (!background && workTab && summary.length) {
        await pageStatus(workTab, { kind: "ok", title: stopRequested ? "Autopilot stopped" : `Autopilot done · ${rows.length} ${rows.length === 1 ? "card" : "cards"}`, rows, actions: [["close", "Close"]] });
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
