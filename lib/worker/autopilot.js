// Autopilot: for each card, update everything from the issuer's site.
//   1. Balance (and new rewards activity), in the tab autopilot runs in
//   2. Offers: added to the card and saved      } at the same time, each in its own background tab
//   3. Benefits: credits the issuer shows as used } next to it (by hand), or one after another (daily run)
// It starts from whatever page is open (home, statements…), follows the site's links to each page,
// and remembers where it found them. No step waits forever: a step that finds nothing moves on.
// Balances are read one card at a time (a site shows one selected card at a time). Offers and
// benefits overlap with the next cards when that's safe: the card is alone on its site, or the site
// keeps the selected card in the page address (Amex's account_key), so its own tabs keep showing it
// while the next card is selected. Up to 3 cards at once. Cards the site lists that aren't in
// Finstracker are added first and run too. A board on the portal page (content/progress.js) shows
// every activity.
// It only ever starts from a click of the user's (Run autopilot, Add cards and run autopilot); there
// is no run by itself. It waits for sign-in and for "Is this your balance?".
import { getState, setState } from "../storage.js";
import { cards as loadCards } from "./account.js";
import { syncBenefits } from "./benefits-sync.js";
import { cancelCapture, fmtValue, startCapture } from "./capture.js";
import { syncOffersForCard } from "./offers-sync.js";
import { notify } from "./tabs.js";
import { distinctWords } from "../programs.js";
import { accountOnPage, accountParam, siteKeyFor } from "./sites.js";
import { addSiteCards, scanSiteCards } from "./new-cards.js";

// Cards whose offers and benefits run at the same time (each card in its own two tabs).
const MAX_PARALLEL = 3;
const siteOf = (url) => { try { return new URL(url).hostname.split(".").slice(-2).join("."); } catch { return ""; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const friendly = (err) => (/no tab with id|tab was closed/i.test(err?.message || "") ? "The tab was closed" : err?.message || "Something went wrong");
// The run in this service worker: { id, stopped, boardTab, tabs }. Each run owns its id, so an
// update that arrives late (offers and benefits report at the same time) can never bring a
// finished or stopped run back.
let run = null;
let queue = Promise.resolve();
/** Every change to autopilotRun goes through here, one after another. */
function locked(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
}
/** Change this run's saved state; nothing happens once the run has ended. */
function updateRun(me, fn) {
    return locked(async () => {
        const { autopilotRun } = await getState(["autopilotRun"]);
        if (!autopilotRun || autopilotRun.id !== me.id) return null;
        const next = fn(autopilotRun);
        await setState({ autopilotRun: next });
        return next;
    });
}
const endBoard = (board, title) => board && { ...board, running: false, title, cards: board.cards.map((c) => ({ ...c, current: false })) };

/** End the run: clear its state and keep its final board. Returns that board. */
function finishRun(me, title) {
    return locked(async () => {
        const { autopilotRun } = await getState(["autopilotRun"]);
        let finalBoard = null;
        if (autopilotRun?.id === me.id) {
            finalBoard = endBoard(autopilotRun.board, title);
            await setState({ autopilotRun: null, captureSession: null, autopilotLastBoard: finalBoard || null });
        }
        if (run === me) run = null;
        return finalBoard;
    });
}

/**
 * A run saved in storage with no run in this service worker (the worker restarted, or the
 * extension was reloaded mid-run) can't finish: mark it stopped so a new run can start.
 */
export async function clearStaleRun() {
    if (run) return;
    await locked(async () => {
        const { autopilotRun } = await getState(["autopilotRun"]);
        if (!autopilotRun || run) return;
        const finalBoard = endBoard(autopilotRun.board, "Autopilot stopped");
        await setState({ autopilotRun: null, autopilotLastBoard: finalBoard || null });
        if (finalBoard && autopilotRun.boardTab) await showBoard(autopilotRun.boardTab, finalBoard);
    });
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

/** Update one activity on the run's board and redraw it. */
async function stepRun(me, cardIndex, stepName, state, text) {
    const next = await updateRun(me, (r) => {
        if (!r.board) return r;
        const board = structuredClone(r.board);
        board.cards.forEach((c, i) => { c.current = i === cardIndex && board.running; });
        const s = board.cards[cardIndex]?.steps.find((x) => x.name === stepName);
        if (s) Object.assign(s, { state, text: text || "" });
        return { ...r, board };
    });
    if (next?.board && !me.stopped) await showBoard(me.boardTab, next.board);
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
async function waitForBalance(cardId, ms, onChange, lookMs = 90 * 1000, stopped = () => false) {
    const end = Date.now() + ms;
    let last = "", lookingSince = null;
    while (Date.now() < end && !stopped()) {
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
async function sideTab(me, mainTabId) {
    let main = null;
    try { main = await chrome.tabs.get(mainTabId); } catch { /* closed */ }
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, ...(main ? { windowId: main.windowId, index: main.index + 1, openerTabId: main.id } : {}) });
    me.tabs.add(tab.id);
    if (me.stopped) await closeTab(me, tab.id);
    return tab;
}
async function closeTab(me, id) {
    me.tabs.delete(id);
    try { await chrome.tabs.remove(id); } catch { /* closed by the user */ }
}

/** Cards were added from the board (or the popup) while autopilot runs: say so on the board. */
export async function boardCardsAdded(added) {
    const me = run;
    if (!me || !added?.length) return;
    const names = added.map((c) => c.displayName).join(", ");
    const next = await updateRun(me, (r) => ({ ...r, board: r.board && { ...r.board, notice: { text: `Added ${names} to Finstracker. Run autopilot again to update ${added.length === 1 ? "it" : "them"} too.`, keys: [] } } }));
    if (next?.board) await showBoard(me.boardTab, next.board);
}

export async function isRunning() {
    if (run && !run.stopped) return true;
    await clearStaleRun();
    return Boolean(run);
}

/**
 * Stop: closes the offers and benefits tabs and the balance step at once; the run ends at its next
 * check (a second or two). If a page keeps it busy, it is ended here after 10 seconds anyway. The
 * daily run waits a day before starting again.
 */
export async function stopAutopilot() {
    await setState({ autopilotStoppedAt: Date.now() });
    const me = run;
    if (!me) { await clearStaleRun(); await cancelCapture(); return { ok: true }; }
    me.stopped = true;
    for (const id of [...me.tabs]) closeTab(me, id);
    await cancelCapture();
    const next = await updateRun(me, (r) => ({ ...r, board: r.board && { ...r.board, title: "Stopping autopilot…" } }));
    if (next?.board) await showBoard(me.boardTab, next.board);
    setTimeout(async () => {
        if (run !== me) return;
        const finalBoard = await finishRun(me, "Autopilot stopped");
        if (finalBoard) await showBoard(me.boardTab, finalBoard);
    }, 10000);
    return { ok: true };
}

/** A card's row on the board, before anything runs. */
const boardCard = (c) => ({ name: c.displayName, current: false, steps: ["Balance", "Offers", "Benefits"].map((name) => ({ name, state: "waiting", text: "" })) });

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
    if (await isRunning()) return { ok: false, error: "Autopilot is already running" };
    const me = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, stopped: false, boardTab: null, tabs: new Set() };
    run = me;
    const step = (...a) => stepRun(me, ...a);
    const progress = (patch) => updateRun(me, (r) => ({ ...r, ...patch }));
    // Keep the service worker awake while the run lasts (it would otherwise be shut down when idle).
    const keepAwake = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
    const useWindows = !background; // by hand: offers and benefits in background tabs, at the same time
    const board = {
        running: true,
        title: `Autopilot · ${cards.length} ${cards.length === 1 ? "card" : "cards"}`,
        cards: cards.map(boardCard),
    };
    let workTab = tabId || (background ? (await chrome.tabs.create({ url: "about:blank", active: false })).id : null);
    me.boardTab = background ? null : workTab;
    await locked(() => setState({ autopilotRun: { id: me.id, running: true, background, total: cards.length, index: 0, cardName: cards[0].displayName, step: "Starting", startedAt: Date.now(), board, boardTab: me.boardTab } }));
    await showBoard(me.boardTab, board);
    // Cards the site lists that aren't in Finstracker yet: offer them on the board.
    if (me.boardTab) {
        const url = (await chrome.tabs.get(me.boardTab).catch(() => null))?.url || "";
        const { fresh } = url ? await scanSiteCards(me.boardTab, url, cards, { open: true }) : { fresh: [] }; // the user clicked Run
        const { autoAddCards } = await getState(["autoAddCards"]);
        // New cards are added to Finstracker and run with the others (unless that's turned off in
        // Settings); "Not mine" cards were left out by the scan.
        const added = fresh.length && autoAddCards !== false && !me.stopped ? ((await addSiteCards(me.boardTab, url, fresh.map((c) => c.key))).added || []) : [];
        if (added.length) {
            const latest = await loadCards({ fresh: true });
            const fresh2 = added.map((a) => latest.find((c) => c.id === a.id) || a);
            cards.push(...fresh2);
            const text = `Added ${fresh2.map((c) => c.displayName).join(", ")} to Finstracker. ${fresh2.length === 1 ? "It runs" : "They run"} with your other cards.`;
            const next = await updateRun(me, (r) => ({ ...r, total: cards.length, board: { ...r.board, title: `Autopilot · ${cards.length} cards`, notice: { text, keys: [] }, cards: [...r.board.cards, ...fresh2.map(boardCard)] } }));
            if (next?.board) await showBoard(me.boardTab, next.board);
        }
        const left = added.length ? [] : fresh; // not added (turned off, or adding failed): offer them
        if (left.length && !me.stopped) {
            const text = `${left.length === 1 ? "A card on this site isn't" : `${left.length} cards on this site aren't`} in Finstracker yet: ${left.map((c) => `${c.name}${c.last4 ? ` •••• ${c.last4}` : ""}`).join(", ")}`;
            const next = await updateRun(me, (r) => ({ ...r, board: { ...r.board, notice: { text, keys: left.map((c) => c.key) } } }));
            if (next?.board) await showBoard(me.boardTab, next.board);
        }
    }
    // Tried today, whatever happens: the daily run doesn't start again on every page load.
    const { autopilot: tried } = await getState(["autopilot"]);
    await setState({ autopilot: { ...(tried || {}), ...Object.fromEntries(cards.map((c) => [c.id, { ...(tried?.[c.id] || {}), lastTry: Date.now() }])) } });
    const summary = [];
    const lines = []; // one per card, in board order (cards may finish out of order)
    const inFlight = new Set();
    // Which cards share a site, and the words that tell them apart in a card switcher.
    const keys = await Promise.all(cards.map(siteKeyFor));
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
            if (me.stopped) break;
            const results = {};
            await progress({ index, cardName: card.displayName, step: "Balance" });

            // 1. Balance and activity (after selecting the card when several share the site).
            const switchTo = switchFor(card, index);
            await step(index, "Balance", "busy", "Starting…");
            const started = await startCapture({ card, tabId: workTab, navigate: Boolean(workTab), background, switchTo });
            let selected = false;
            if (started.ok) {
                workTab = workTab || started.session.tabId;
                if (!me.boardTab && !background) {
                    me.boardTab = workTab;
                    const next = await progress({ boardTab: me.boardTab });
                    if (next?.board) await showBoard(me.boardTab, next.board);
                }
                const s = await waitForBalance(card.id, background ? 3 * 60 * 1000 : 10 * 60 * 1000, (now) => {
                    const [state, text] = now.status === "confirm" ? ["busy", "Waiting for your OK on the page"] : fromStatus(now);
                    return step(index, "Balance", state, text);
                }, 90 * 1000, () => me.stopped);
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
                    lines[index] = `${card.displayName}: ${why}`;
                    await saveResults(card, results);
                    continue;
                }
            } else {
                results.balance = started.error;
                await step(index, "Balance", "error", started.error);
            }
            if (me.stopped) break;

            // 2 and 3. Offers and benefits.
            await progress({ step: "Offers and benefits" });
            const ready = { ...switchTo, ready: selected };
            const job = (name) => ({
                report: (patch) => { const [state, text] = fromStatus(patch); return step(index, name, state, text); },
                stopped: () => me.stopped,
            });
            // The page shows this card now. A key for it in the address (Amex's account_key) lets
            // its own tabs keep showing it while the next card is selected in this one.
            const here = workTab ? (await chrome.tabs.get(workTab).catch(() => null))?.url || "" : "";
            const key = !switchTo || selected ? accountParam(here) || (workTab ? await accountOnPage(workTab) : null) : null;
            const account = key ? { ...key, host: siteOf(here) } : null;
            const overlap = useWindows && workTab && (!switchTo || account);
            const mainTab = workTab;
            const work = (async () => {
                let offers, benefits;
                try {
                    if (useWindows && mainTab) {
                        // Each in its own background tab, at the same time. Same card, same sign-in.
                        const [ot, bt] = await Promise.all([sideTab(me, mainTab), sideTab(me, mainTab)]);
                        await Promise.all([step(index, "Offers", "busy", "Opening offers in a background tab…"), step(index, "Benefits", "busy", "Opening benefits in a background tab…")]);
                        [offers, benefits] = await Promise.all([
                            syncOffersForCard(card, { tabId: ot.id, navigate: true, background: true, switchTo: switchTo && ready, job: job("Offers"), account }),
                            syncBenefits(card, { tabId: bt.id, navigate: true, background: true, switchTo: switchTo && ready, job: job("Benefits"), account }),
                        ]);
                        await Promise.all([closeTab(me, ot.id), closeTab(me, bt.id)]);
                    } else {
                        offers = await syncOffersForCard(card, { tabId: mainTab, navigate: true, background, switchTo: switchTo && ready, job: job("Offers") });
                        if (!me.stopped) benefits = await syncBenefits(card, { tabId: mainTab, navigate: true, background, switchTo: switchTo && ready, job: job("Benefits") });
                    }
                } catch (err) {
                    console.warn("[finstracker] autopilot step failed", card.displayName, err?.message || err);
                    offers = offers || { ok: false, error: friendly(err) };
                    benefits = benefits || { ok: false, error: friendly(err) };
                }
                results.offers = offers?.ok ? `${offers.added ? `${offers.added} added · ` : ""}${offers.found} offers saved${offers.notAdded ? ` · ${offers.notAdded} not added` : ""}` : offers?.skipped ? "Offers skipped" : offers?.error || "Stopped";
                results.benefits = benefits?.ok ? (benefits.marked.length ? `Marked used: ${benefits.marked.join(", ")}` : `${benefits.read} read · nothing new used`) : benefits?.skipped ? "Benefits skipped" : benefits?.error || "Stopped";
                await step(index, "Offers", offers?.ok ? "done" : offers?.skipped ? "skipped" : "error", results.offers);
                await step(index, "Benefits", benefits?.ok ? "done" : benefits?.skipped ? "skipped" : "error", results.benefits);
                await saveResults(card, results);
                lines[index] = `${card.displayName}: ${[results.balance, results.offers, results.benefits].filter(Boolean).join(" · ")}`;
            })();
            if (!overlap) { await work; continue; }
            // On to the next card's balance while this one's offers and benefits run.
            inFlight.add(work);
            work.finally(() => inFlight.delete(work));
            while (inFlight.size >= MAX_PARALLEL && !me.stopped) await Promise.race(inFlight);
        }
        await Promise.all(inFlight);
    } catch (err) {
        console.warn("[finstracker] autopilot stopped by an error", err);
        await setState({ autopilotError: String(err?.stack || err) });
        summary.push(`Autopilot stopped: ${err?.message || err}`);
    } finally {
        clearInterval(keepAwake);
        for (const id of [...me.tabs]) await closeTab(me, id);
        if (background && workTab && !tabId) chrome.tabs.remove(workTab).catch(() => {});
        const finalBoard = await finishRun(me, me.stopped ? "Autopilot stopped" : `Autopilot done · ${cards.length} ${cards.length === 1 ? "card" : "cards"}`);
        if (finalBoard && me.boardTab) await showBoard(me.boardTab, finalBoard);
    }
    summary.unshift(...lines.filter(Boolean));
    if (summary.length) notify("Finstracker autopilot", summary.join("\n").slice(0, 400));
    return { ok: true, summary, stopped: me.stopped };
}
