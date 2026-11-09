// Card benefits: read the issuer's benefits page ("Uber Cash · $10 of $10 used") and mark the
// matching credits used in Finstracker.
import { Tracker } from "../api.js";
import { localToday } from "../benefits.js";
import { matchBenefits } from "../benefit-match.js";
import { normalizeIssuer } from "../programs.js";
import { getState, setState } from "../storage.js";
import { session } from "./account.js";
import { findLinkOn, notify, pageSettled, pageStatus, readBenefitsOn, showsSignIn, switchAccountOn } from "./tabs.js";
import { ensureShownCard, portalForCard, siteName, workTab } from "./sites.js";

// Benefits pages we know; elsewhere the site's own "Benefits" / "Credits" link is followed.
const BENEFIT_PAGES = {
    "American Express": "https://global.americanexpress.com/card-benefits/view-all",
};
const LINK_WORDS = ["card benefits", "benefits", "credits", "statement credits", "perks"];
const WAIT_MS = 5 * 60 * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function setSession(card, patch) {
    const { captureSession } = await getState(["captureSession"]);
    const base = captureSession?.kind === "benefits" && captureSession.cardId === card.id ? captureSession : { kind: "benefits", cardId: card.id, cardName: card.displayName, issuer: card.issuer, startedAt: Date.now() };
    await setState({ captureSession: { ...base, expiresAt: Date.now() + WAIT_MS, ...patch } });
}

/** Mark the credits a benefits page shows as used. Returns { ok, read, marked: [titles] }. */
export async function syncBenefits(card, { tabId = null, navigate = false, background = false, switchTo = null } = {}) {
    if (!card?.id) return { ok: false, error: "Missing card" };
    const { apiBase, token } = await session();
    if (!token) return { ok: false, error: "Sign in to Finstracker first", signedOut: true };
    const portal = await portalForCard(card, { bank: true });
    const page = BENEFIT_PAGES[normalizeIssuer(card.issuer)] || null;
    const tab = await workTab({ tabId, portal, url: page, navigate: navigate || !tabId, background });
    if (!tab) return { ok: false, error: `Open your ${card.displayName} benefits page first, then choose Sync benefits.` };
    await setSession(card, { tabId: tab.id, status: "opening", statusLabel: `Opening ${card.displayName} benefits…` });

    const tried = [];
    let cardChecks = 0;
    const deadline = Date.now() + (tabId && !navigate ? 45000 : WAIT_MS);
    while (Date.now() < deadline) {
        await pause(1500);
        let info;
        try { info = await chrome.tabs.get(tab.id); } catch { return { ok: false, error: "The tab was closed" }; }
        const { captureSession } = await getState(["captureSession"]);
        if (captureSession?.kind !== "benefits" || captureSession.cardId !== card.id) return { ok: false, error: "Cancelled" };
        if (info.status !== "complete") continue;
        if (await showsSignIn(tab.id)) {
            if (background) return { ok: false, error: `Sign in to ${siteName(info.url)} first`, needsSignIn: true };
            await setSession(card, { status: "awaiting-login", statusLabel: `Sign in to ${siteName(info.url)}` });
            await pageStatus(tab.id, { kind: "busy", title: `Sign in to ${siteName(info.url)}`, text: `Finstracker will check your ${card.displayName} benefits once you're in.`, actions: [["close", "Cancel"]] });
            continue;
        }
        await setSession(card, { status: "watching", statusLabel: `Reading ${card.displayName} benefits…`, currentUrl: info.url });
        await pageStatus(tab.id, { kind: "busy", title: `Checking your ${card.displayName} benefits…` });
        await pageSettled(tab.id);
        const benefits = await readBenefitsOn(tab.id);
        if (!benefits.length) {
            if (tried.length < 2) {
                const link = await findLinkOn(tab.id, LINK_WORDS, tried);
                if (link?.href) { tried.push(link.href); await chrome.tabs.update(tab.id, { url: link.href }); continue; }
                if (link?.clicked) { tried.push(info.url); continue; }
            }
            break;
        }
        // Several of the user's cards on this site: only benefits for the card the page shows.
        const shown = await ensureShownCard(tab.id, card, { siteCards: switchTo?.cards || null, requireVerified: Boolean(switchTo) && !switchTo.ready, attempt: cardChecks++ });
        if (!shown.ok) {
            await setSession(card, { status: "error", lastError: shown.message });
            await pageStatus(tab.id, { kind: "error", title: "Benefits skipped", text: shown.message, autoHide: 6000 });
            return { ok: false, skipped: true, error: shown.message };
        }
        if (shown.clicked) { await pageSettled(tab.id); continue; }
        let perks = [];
        try { perks = ((await Tracker.listCredits(apiBase, token)) || []).filter((p) => p.cardId === card.id); } catch { perks = []; }
        const marks = matchBenefits(perks, benefits, localToday());
        const marked = [];
        for (const { perk } of marks) {
            try { await Tracker.setCreditUsed(apiBase, token, perk.id, true); marked.push(perk.title.split(" · ")[0]); } catch { /* keep going */ }
        }
        const label = marked.length ? `Marked used: ${marked.join(", ")}` : `${benefits.length} benefits checked · nothing new used`;
        await setSession(card, { status: "synced", statusLabel: label, lastScrape: { benefits: benefits.length, marked: marked.length, at: Date.now() } });
        await pageStatus(tab.id, { kind: "ok", title: `${card.displayName} benefits checked`, text: label, autoHide: 7000 });
        if (marked.length) notify("Finstracker", `${card.displayName}: ${label}`);
        return { ok: true, kind: "benefits", read: benefits.length, marked };
    }
    const message = "Couldn't find benefit usage on this page. Open the card's benefits page and choose Sync benefits.";
    await setSession(card, { status: "error", lastError: message });
    await pageStatus(tab.id, { kind: "error", title: "No benefits found", text: message, actions: [["close", "Close"]] });
    return { ok: false, error: message };
}
