// Card benefits: read the issuer's benefits page ("Uber Cash · $10 of $10 used") and mark the
// matching credits used in Finstracker.
import { Tracker } from "../api.js";
import { localToday } from "../benefits.js";
import { benefitReport, matchBenefits } from "../benefit-match.js";
import { cardIssuer } from "../programs.js";
import { startPage, urlMatches } from "../portals.js";
import { getState, setState } from "../storage.js";
import { session } from "./account.js";
import { expandDetailsOn, findLinkOn, notify, pageSettled, pageStatus, readBenefitsOn, showsSignIn, switchAccountOn } from "./tabs.js";
import { ensureShownCard, learnPage, learnedPage, portalForCard, siteName, withAccount, workTab } from "./sites.js";

// Benefits pages we know; elsewhere the site's own links and tabs are followed. Amex keeps usage
// ("$15 Earned Nov · $0 To Go") under Track Progress on the Benefits Activity tab, not on Browse.
const BENEFIT_PAGES = {
    "American Express": "https://global.americanexpress.com/card-benefits/activity",
};
// Best first: a usage tab or tracker, then the benefits pages that lead to one.
const LINK_WORDS = ["benefits activity", "benefit activity", "track progress", "benefit tracker", "benefits tracker", "credit tracker", "track benefits", "card benefits", "benefits", "statement credits", "credits", "perks"];
const MAX_HOPS = 4;
const WAIT_MS = 5 * 60 * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A one-off sync was cancelled (or replaced) from the panel or the page. */
async function notCurrent(card, kind) {
    const { captureSession } = await getState(["captureSession"]);
    return captureSession?.kind !== kind || captureSession.cardId !== card.id;
}

async function setSession(card, patch) {
    const { captureSession } = await getState(["captureSession"]);
    const base = captureSession?.kind === "benefits" && captureSession.cardId === card.id ? captureSession : { kind: "benefits", cardId: card.id, cardName: card.displayName, issuer: card.issuer, startedAt: Date.now() };
    await setState({ captureSession: { ...base, expiresAt: Date.now() + WAIT_MS, ...patch } });
}

/** Mark the credits a benefits page shows as used. Returns { ok, read, marked: [titles] }. */
export async function syncBenefits(card, { tabId = null, navigate = false, background = false, switchTo = null, job = null, account = null } = {}) {
    // Autopilot passes a job: progress goes to its board (several steps run at once in other windows),
    // not to the single sync status the side panel shows for one-off syncs.
    const report = job ? async (patch) => job.report(patch) : (patch) => setSession(card, patch);
    if (!card?.id) return { ok: false, error: "Missing card" };
    const { apiBase, token } = await session();
    if (!token) return { ok: false, error: "Sign in to Finstracker first", signedOut: true };
    const portal = await portalForCard(card, { bank: true });
    // Where the benefits were found last time, else the issuer's benefits page; never a page off the
    // card's own site (a card linked to another site follows that site's links instead).
    const onHome = (u) => Boolean(u) && (!portal?.matchUrl?.length || urlMatches(portal.matchUrl, u));
    // account: the card's own key in the site's addresses (Amex), so this tab shows this card.
    const page = withAccount([await learnedPage(card, "benefits"), BENEFIT_PAGES[cardIssuer(card)]].find(onHome) || null, account);
    // No known benefits page: start from the bank's own site (unless the tab is already there) and
    // follow its "Benefits" link below.
    let start = page;
    if (!start && navigate && tabId) {
        const current = await chrome.tabs.get(tabId).catch(() => null);
        if (portal && !(current && urlMatches(portal.matchUrl, current.url || ""))) start = withAccount(startPage(portal), account);
    }
    const tab = await workTab({ tabId, portal, url: start, navigate: navigate || !tabId, background });
    if (!tab) return { ok: false, error: `Open your ${card.displayName} benefits page first, then choose Sync benefits.` };
    await report({ tabId: tab.id, status: "opening", statusLabel: `Opening ${card.displayName} benefits…` });

    const tried = [];
    let cardChecks = 0, empty = 0;
    // Autopilot: never more than 3 minutes on one step.
    const deadline = Date.now() + (tabId && !navigate ? 45000 : job ? 3 * 60 * 1000 : WAIT_MS);
    while (Date.now() < deadline) {
        await pause(1500);
        let info;
        try { info = await chrome.tabs.get(tab.id); } catch { return { ok: false, error: "The tab was closed" }; }
        if (job ? job.stopped() : await notCurrent(card, "benefits")) return { ok: false, error: "Cancelled" };
        if (info.status !== "complete") continue;
        if (await showsSignIn(tab.id)) {
            if (background) return { ok: false, error: `Sign in to ${siteName(info.url)} first`, needsSignIn: true };
            await report({ status: "awaiting-login", statusLabel: `Sign in to ${siteName(info.url)}` });
            await pageStatus(tab.id, { kind: "busy", title: `Sign in to ${siteName(info.url)}`, text: `Finstracker will check your ${card.displayName} benefits once you're in.`, actions: [["close", "Cancel"]] });
            continue;
        }
        await report({ status: "watching", statusLabel: `Reading ${card.displayName} benefits…`, currentUrl: info.url });
        await pageStatus(tab.id, { kind: "busy", title: `Checking your ${card.displayName} benefits…` });
        await pageSettled(tab.id);
        // Usage often sits in collapsed "View details" / "Track progress" sections: open them first.
        await expandDetailsOn(tab.id);
        await pageSettled(tab.id);
        const benefits = await readBenefitsOn(tab.id);
        if (!benefits.length) {
            // On the page we expected them on, give it another look first (it loads late).
            if (start && !tried.length && ++empty < 3) { await report({ status: "watching", statusLabel: `Looking for ${card.displayName} benefits on ${siteName(info.url)}…`, currentUrl: info.url }); continue; }
            // Click through the site: its Benefits link, then the tab that shows usage.
            if (tried.length < MAX_HOPS) {
                await report({ status: "watching", statusLabel: `Looking around ${siteName(info.url)} for ${card.displayName} benefits…`, currentUrl: info.url });
                const link = await findLinkOn(tab.id, LINK_WORDS, tried);
                if (link?.href) { tried.push(link.href); empty = 0; await chrome.tabs.update(tab.id, { url: link.href }); continue; }
                if (link?.clicked) { tried.push(`text:${link.text}`); empty = 0; await pageSettled(tab.id); continue; }
            }
            break;
        }
        // Several of the user's cards on this site: only benefits for the card the page shows.
        const shown = await ensureShownCard(tab.id, card, { siteCards: switchTo?.cards || null, requireVerified: Boolean(switchTo) && !switchTo.ready, attempt: cardChecks++ });
        if (!shown.ok) {
            await report({ status: "error", lastError: shown.message });
            await pageStatus(tab.id, { kind: "error", title: "Benefits skipped", text: shown.message, autoHide: 6000 });
            return { ok: false, skipped: true, error: shown.message };
        }
        if (shown.clicked) { await pageSettled(tab.id); continue; }
        let all = [];
        try { all = ((await Tracker.listAllCredits(apiBase, token)) || []).filter((p) => p.cardId === card.id); } catch { all = []; }
        const marks = matchBenefits(all.filter((p) => !p.used), benefits, localToday());
        const marked = [];
        const done = [];
        for (const m of marks) {
            try { await Tracker.setCreditUsed(apiBase, token, m.perk.id, true); marked.push(m.perk.title.split(" · ")[0]); done.push(m); } catch { /* keep going */ }
        }
        // What was read and what happened to each benefit, so you can see it was understood.
        const rows = benefitReport(benefits, done, all);
        const label = marked.length ? `Marked used: ${marked.join(", ")}` : `${benefits.length} benefits checked · nothing new used`;
        await learnPage(card, "benefits", info.url).catch(() => {});
        await report({ status: "synced", statusLabel: label, rows, lastScrape: { benefits: benefits.length, marked: marked.length, at: Date.now() } });
        await pageStatus(tab.id, { kind: "ok", title: `${card.displayName}: ${benefits.length} ${benefits.length === 1 ? "benefit" : "benefits"} read`, rows: rows.slice(0, 10), actions: [["close", "Close"]] });
        if (marked.length) notify("Finstracker", `${card.displayName}: ${label}`);
        return { ok: true, kind: "benefits", read: benefits.length, marked, rows };
    }
    const message = "Couldn't find benefit usage on this page. Open the card's benefits page and choose Sync benefits.";
    await report({ status: "error", lastError: message });
    await pageStatus(tab.id, { kind: "error", title: "No benefits found", text: message, actions: [["close", "Close"]] });
    return { ok: false, error: message };
}
