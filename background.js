// extension/background.js — MV3 service worker for the Fins Sync extension.
//
// Responsibilities:
//   1. Watch tab navigations while a capture session is active and run the
//      content extractor on the configured portal URL.
//   2. (Optional) auto-detect known issuer portals and offer to sync.
//   3. Compute the delta between the scraped value and the current card
//      balance, then POST it as an earn/redeem transaction to the backend.
//   4. Provide a message API for the popup (login, listCards, startCapture,
//      cancelCapture, syncFromActiveTab, openPicker, pickerResult).
//
// Security notes:
//   - JWT lives in chrome.storage.local; never injected into pages.
//   - Content scripts are injected programmatically only on the active
//     capture tab or on tabs matching a known portal — never broadly.
//   - All numeric input from pages is re-validated server-side by the
//     existing transaction validators.

import { Tracker } from "./lib/api.js";
import { getState, setState, clearAuth } from "./lib/storage.js";

const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

let portalsCache = null;
async function loadPortals() {
    if (portalsCache) return portalsCache;
    const url = chrome.runtime.getURL("portals.json");
    const res = await fetch(url);
    portalsCache = await res.json();
    return portalsCache;
}

// ---- helpers -------------------------------------------------------------

function urlMatches(pattern, url) {
    if (!pattern || !url) return false;
    // Convert simple "https://*.example.com/*" globs to regex.
    // Escape every regex metachar EXCEPT `*`, then translate `*` to `.*`.
    const rx = new RegExp(
        "^" +
        pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*") +
        "$"
    );
    return rx.test(url);
}

function parseNumber(text) {
    if (!text) return null;
    // Normalize unicode whitespace (\u00a0 nbsp, \u202f narrow nbsp, \u2009 thin sp)
    // that issuer portals frequently use as digit-group separators.
    const norm = String(text).replace(/[\u00a0\u202f\u2009\u2007]/g, " ");
    // First numeric token like "12,345" or "1234.56" — strip commas, keep dot.
    const m = norm.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
}

// Runs inside the target page. Tries the configured selector list first,
// then falls back to a heuristic scan that finds numbers near reward-related
// keywords ("points", "miles", "rewards", "balance", "cash back"). Returns
// the best candidate or null.
function pageExtractor(selectorList, regexStr, unitHint) {
    const KEYWORDS = [
        "membership rewards", "ultimate rewards", "thankyou points",
        "miles", "points", "rewards balance", "rewards", "cash back",
        "cashback", "balance",
    ];
    const STRONG_KEYWORDS = [
        "rewards balance", "ultimate rewards", "membership rewards",
        "thankyou points", "go far rewards", "mileage plan",
        "points balance", "miles balance", "cashback bonus", "cash back balance",
    ];
    const NUMERIC_RX = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

    function pickText(el) {
        if (!el) return "";
        const raw = (el.innerText || el.textContent || "");
        // Normalize unicode spaces (nbsp / narrow nbsp / thin space) that
        // many banking portals use as digit-group separators.
        return raw.replace(/[\u00a0\u202f\u2009\u2007]/g, " ").trim();
    }
    function isVisible(el) {
        if (!(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
        return true;
    }
    function parseNum(s) {
        if (!s) return null;
        const norm = String(s).replace(/[\u00a0\u202f\u2009\u2007]/g, " ");
        const m = norm.match(/-?\d[\d,]*(?:\.\d+)?/);
        if (!m) return null;
        const n = Number(m[0].replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
    }

    // Shadow-DOM-piercing traversal. Many issuer portals (Capital One,
    // some Chase widgets, Discover) wrap their dashboard chrome in open
    // shadow roots; document.querySelectorAll never descends into them.
    function deepWalk(root, fn) {
        if (!root) return;
        // The root itself may be a ShadowRoot or Element.
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (!node) continue;
            const children = node.children || [];
            for (let i = 0; i < children.length; i++) {
                const ch = children[i];
                fn(ch);
                if (ch.shadowRoot) stack.push(ch.shadowRoot);
                if (ch.children && ch.children.length) stack.push(ch);
            }
        }
    }
    function deepQuerySelectorAll(sel) {
        const out = [];
        try {
            document.querySelectorAll(sel).forEach((n) => out.push(n));
        } catch { return out; }
        deepWalk(document.documentElement, (el) => {
            if (el.shadowRoot) {
                try { el.shadowRoot.querySelectorAll(sel).forEach((n) => out.push(n)); }
                catch { /* ignore */ }
            }
        });
        return out;
    }

    // Adjacent-label proximity: many balances render as a small label
    // ("Ultimate Rewards balance") + a big number nearby (sibling or
    // previous/next text). Boost when a strong keyword appears in the
    // element's preceding sibling, next sibling, or parent's other
    // children within a tiny radius. Returns the matched keyword or null.
    function nearbyLabelKeyword(el) {
        const radius = 3;
        const candidates = [];
        let prev = el.previousElementSibling, n = 0;
        while (prev && n < radius) { candidates.push(prev); prev = prev.previousElementSibling; n++; }
        let next = el.nextElementSibling; n = 0;
        while (next && n < radius) { candidates.push(next); next = next.nextElementSibling; n++; }
        const parent = el.parentElement;
        if (parent) {
            const kids = parent.children || [];
            for (let i = 0; i < kids.length && i < 12; i++) {
                if (kids[i] !== el) candidates.push(kids[i]);
            }
        }
        for (const c of candidates) {
            const t = ((c.innerText || c.textContent || "")).toLowerCase();
            if (t.length > 200) continue;
            for (const k of STRONG_KEYWORDS) if (t.includes(k)) return k;
            for (const k of KEYWORDS) if (t.includes(k)) return k;
        }
        return null;
    }

    // 1) Configured selectors (with optional capture-group regex).
    const selectors = (selectorList || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
    for (const sel of selectors) {
        const nodes = deepQuerySelectorAll(sel);
        for (const n of nodes) {
            if (!isVisible(n)) continue;
            const txt = pickText(n);
            if (!txt) continue;
            if (regexStr) {
                try {
                    const rx = new RegExp(regexStr);
                    const m = txt.match(rx);
                    if (m) {
                        return {
                            text: m[1] || m[0],
                            html: n.outerHTML.slice(0, 400),
                            selector: sel,
                            via: "selector+regex",
                        };
                    }
                } catch { /* fall through */ }
            } else if (/\d/.test(txt)) {
                return {
                    text: txt,
                    html: n.outerHTML.slice(0, 400),
                    selector: sel,
                    via: "selector",
                };
            }
        }
    }

    // 2) Heuristic: collect every visible leaf-ish element with digits, score it.
    // Walk both the light DOM and every open shadow root we can reach.
    const all = [];
    if (document.body) document.body.querySelectorAll("*").forEach((n) => all.push(n));
    deepWalk(document.documentElement, (el) => {
        if (el.shadowRoot) {
            try { el.shadowRoot.querySelectorAll("*").forEach((n) => all.push(n)); }
            catch { /* ignore */ }
        }
    });
    const candidates = [];
    for (const el of all) {
        if (el.children.length > 4) continue;            // skip large containers
        if (!isVisible(el)) continue;
        const txt = pickText(el);
        if (!txt || txt.length > 80) continue;
        if (!NUMERIC_RX.test(txt)) continue;
        NUMERIC_RX.lastIndex = 0;

        // Skip elements that live inside transaction-history / activity
        // sections — banking dashboards have these everywhere and the
        // largest number is almost never the balance. Also walks across
        // shadow-root boundaries via `host`.
        let inExcluded = false;
        let walk = el;
        for (let d = 0; d < 10 && walk; d++) {
            const cls = (walk.getAttribute && walk.getAttribute("class")) || "";
            const id = (walk.getAttribute && walk.getAttribute("id")) || "";
            const role = (walk.getAttribute && walk.getAttribute("role")) || "";
            const dt = (walk.getAttribute && walk.getAttribute("data-testid")) || "";
            const al = (walk.getAttribute && walk.getAttribute("aria-label")) || "";
            const blob = (cls + " " + id + " " + dt + " " + al).toLowerCase();
            if (/transaction|activity|recent|statement|payment-due|minimum|autopay|installment|offer|deal|merchant|spend-category|hist|pending-charge|posted/i.test(blob)) {
                inExcluded = true; break;
            }
            if (role === "row" || role === "rowgroup" || role === "table" || role === "cell") {
                inExcluded = true; break;
            }
            const nextWalk = walk.parentElement
                || (walk.parentNode && walk.parentNode.host)
                || null;
            walk = nextWalk;
        }
        if (inExcluded) continue;

        const nums = txt.match(NUMERIC_RX) || [];
        if (!nums.length) continue;

        for (const raw of nums) {
            const n = Number(raw.replace(/,/g, ""));
            if (!Number.isFinite(n)) continue;
            if (unitHint === "points") {
                if (n < 10 || n > 50_000_000) continue;     // points usually 10..50M
            } else if (unitHint === "cashback") {
                if (n < 0 || n > 1_000_000) continue;
            } else {
                if (n < 1 || n > 50_000_000) continue;
            }

            // Score: keyword proximity + currency/unit hints − penalties.
            let score = 0;
            const lower = txt.toLowerCase();
            let inlineKeyword = false;
            let inlineStrong = false;
            for (const k of STRONG_KEYWORDS) if (lower.includes(k)) { score += 12; inlineStrong = true; inlineKeyword = true; break; }
            if (!inlineKeyword) {
                for (const k of KEYWORDS) if (lower.includes(k)) { score += 8; inlineKeyword = true; break; }
            }

            // Walk up 4 ancestors and aria-labels for keyword context.
            let ctx = "", cur = el;
            let ctxKeyword = false;
            let ctxStrong = false;
            for (let d = 0; d < 5 && cur; d++) {
                if (cur.getAttribute) {
                    const al = cur.getAttribute("aria-label");
                    if (al) ctx += " " + al.toLowerCase();
                    const dt = cur.getAttribute("data-testid") || "";
                    if (dt) ctx += " " + dt.toLowerCase();
                    const dpn = cur.getAttribute("data-pt-name") || "";
                    if (dpn) ctx += " " + dpn.toLowerCase();
                    const cls = cur.getAttribute("class") || "";
                    if (cls) ctx += " " + cls.toLowerCase();
                }
                if (cur.parentElement) {
                    const sib = pickText(cur.parentElement).toLowerCase();
                    if (sib.length < 200) ctx += " " + sib;
                }
                cur = cur.parentElement;
            }
            for (const k of STRONG_KEYWORDS) if (ctx.includes(k)) { score += 7; ctxStrong = true; ctxKeyword = true; break; }
            if (!ctxKeyword) {
                for (const k of KEYWORDS) if (ctx.includes(k)) { score += 5; ctxKeyword = true; break; }
            }

            // Adjacent-label proximity (sibling-level "Rewards balance" + big number).
            const labelKey = nearbyLabelKeyword(el);
            if (labelKey) {
                score += STRONG_KEYWORDS.includes(labelKey) ? 10 : 6;
                ctxKeyword = true;
            }

            // CRITICAL: only score numbers that have a points/rewards
            // keyword somewhere in their inline text, ancestor context,
            // or an adjacent sibling label. Otherwise we'll pick
            // statement balances, credit limits, etc.
            if (!inlineKeyword && !ctxKeyword) continue;

            // Unit discrimination. Currency symbols indicate cashback;
            // "pts" / "points" / "miles" indicate points. Penalize
            // mismatches hard so the heuristic doesn't pick a statement
            // balance ($X,XXX.XX) when we're looking for points.
            const hasCurrency = /\$|usd|\bdollar/i.test(txt) || /\$|usd|\bdollar/i.test(ctx);
            const hasPointsUnit = /\b(pts?|points?|miles?)\b/i.test(txt) || /\b(pts?|points?|miles?)\b/i.test(ctx);
            if (unitHint === "cashback" && (hasCurrency || lower.includes("cash"))) score += 3;
            if (unitHint === "points" && hasPointsUnit) score += 5;
            if (unitHint === "points" && hasCurrency && !hasPointsUnit) score -= 14;
            if (unitHint === "cashback" && hasPointsUnit && !hasCurrency) score -= 10;

            // Bonus when the unit token appears immediately after the
            // chosen number, e.g. "3,199 points" or "$45.00 cash back".
            const tail = txt.slice(txt.indexOf(raw) + raw.length, txt.indexOf(raw) + raw.length + 24).toLowerCase();
            if (unitHint === "points" && /^\s*(pts?|points?|miles?)\b/.test(tail)) score += 6;
            if (unitHint === "cashback" && /^\s*(cash|back|cb|usd|dollars?)\b/.test(tail)) score += 4;

            // Bigger numbers usually = balance (not "Earn 3x"); also raw with commas wins.
            if (/,/.test(raw)) score += 4;
            if (n >= 1000) score += 2;
            if (n >= 10000) score += 1;

            // Penalties: percentages, dates, phone numbers, "x" multipliers,
            // credit limits, statement balances, payment due.
            if (/%|\d{1,2}\/\d{1,2}|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}x\b/i.test(txt)) score -= 12;
            if (/\b(zip|account|card|ending|exp|expir|interest|apr|fee|credit limit|available credit|statement balance|minimum|payment due|autopay|installment)\b/i.test(txt + " " + ctx)) score -= 10;
            if (n < 100 && unitHint === "points") score -= 4;

            // Visual weight: larger fonts and bold likely the headline balance.
            try {
                const cs = getComputedStyle(el);
                const fs = parseFloat(cs.fontSize) || 14;
                if (fs >= 28) score += 5;
                else if (fs >= 22) score += 3;
                else if (fs >= 18) score += 1;
                if (parseInt(cs.fontWeight, 10) >= 600) score += 1;
            } catch { /* noop */ }

            candidates.push({ el, n, raw, txt, score });
        }
    }

    candidates.sort((a, b) => b.score - a.score || b.n - a.n);
    const best = candidates[0];
    if (!best || best.score < 8) return null;

    // Build a stable selector for the chosen element.
    function shortSelector(el) {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const dt = el.getAttribute && el.getAttribute("data-testid");
        if (dt) return `[data-testid="${dt}"]`;
        const cls = (el.className && typeof el.className === "string")
            ? el.className.trim().split(/\s+/).filter((c) => c && !/^\d/.test(c) && c.length < 40).slice(0, 2)
            : [];
        return el.tagName.toLowerCase() + (cls.length ? "." + cls.map(CSS.escape).join(".") : "");
    }

    return {
        text: best.raw,
        html: best.el.outerHTML.slice(0, 400),
        selector: shortSelector(best.el),
        via: "heuristic",
        score: best.score,
        candidates: candidates.slice(0, 5).map((c) => ({ text: c.txt, n: c.n, score: c.score })),
    };
}

// Diagnostic: dump every candidate to the page console regardless of
// threshold. Available as window.__finsScan() from the dashboard tab once
// injected. Useful when the user reports a wrong pick.
function pageScannerDebug(extractorSrc, selectorList, regexStr, unitHint) {
    // eslint-disable-next-line no-new-func
    const extractor = new Function("selectorList", "regexStr", "unitHint",
        `return (${extractorSrc})(selectorList, regexStr, unitHint);`);
    const r = extractor(selectorList, regexStr, unitHint);
    console.log("[finstracker] scan result:", r);
    return r;
}

async function extractFromTab(tabId, selector, regex, unitHint) {
    // Try top frame first; if nothing, scan all frames and pick the best.
    const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: pageExtractor,
        args: [selector, regex || null, unitHint || null],
        world: "MAIN",
    });
    let best = null;
    for (const r of results) {
        const v = r?.result;
        if (!v) continue;
        if (!best) { best = v; continue; }
        // Prefer explicit selector match over heuristic; otherwise higher score.
        if (best.via === "heuristic" && v.via !== "heuristic") { best = v; continue; }
        if (best.via === "heuristic" && v.via === "heuristic" && (v.score || 0) > (best.score || 0)) {
            best = v;
        }
    }
    return best;
}

async function resolvePortalForCard(card, portalOverrides) {
    // Layer order: user override > per-card preset > per-issuer preset.
    // Overrides only ever store { matchUrl, selector, capturedUrl, regex,
    // source } — they intentionally don't carry loginUrl / pointsUrlHint,
    // because we still want to send the user to the issuer's canonical
    // sign-in page on the next sync. We therefore always look up the
    // issuer/card preset and merge it in below.
    const portals = await loadPortals();
    const issuers = portals.issuers || portals;       // tolerate the old flat shape
    const cards = portals.cards || {};

    const issuerCfg = issuers[card.issuer] || null;
    const cardCfg = card.cardKey ? cards[card.cardKey] : null;
    const override = portalOverrides?.[card.id];

    if (override?.matchUrl && override?.selector) {
        return {
            matchUrl: override.matchUrl,
            selector: override.selector,
            regex: override.regex || null,
            capturedUrl: override.capturedUrl || null,
            // Critical: always preserve a login URL so the next sync
            // actually navigates somewhere. Prefer the captured URL we
            // know works, fall back to issuer/card defaults.
            loginUrl: override.capturedUrl
                || cardCfg?.loginUrl
                || issuerCfg?.loginUrl
                || cardCfg?.pointsUrlHint
                || issuerCfg?.pointsUrlHint
                || null,
            pointsUrlHint: cardCfg?.pointsUrlHint || issuerCfg?.pointsUrlHint || override.capturedUrl || null,
            source: override.source || "override",
        };
    }

    if (!issuerCfg && !cardCfg) return null;

    // Per-card values win when present; selectors are concatenated so the
    // extractor tries the card-specific ones first and then the issuer-wide
    // fallbacks. matchUrl always comes from the issuer unless the card
    // explicitly overrides it (rare — e.g. Amazon Prime Visa lives on amazon.com).
    const selector = [cardCfg?.selector, issuerCfg?.selector]
        .filter(Boolean).join(", ") || null;
    return {
        matchUrl: cardCfg?.matchUrl || issuerCfg?.matchUrl || null,
        loginUrl: cardCfg?.loginUrl || issuerCfg?.loginUrl || null,
        pointsUrlHint: cardCfg?.pointsUrlHint || issuerCfg?.pointsUrlHint || null,
        selector,
        regex: cardCfg?.regex || issuerCfg?.regex || null,
        source: cardCfg ? "card" : "issuer",
    };
}

async function syncCardBalance(card, scrapedNumber) {
    const { apiBase, token } = await getState(["apiBase", "token"]);
    if (!token) return { ok: false, error: "Not logged in to Fins" };

    // Fetch a fresh card to compute the delta against authoritative state.
    let fresh;
    try {
        fresh = await Tracker.getCard(apiBase, token, card.id);
    } catch (err) {
        return { ok: false, error: err.message || "Card lookup failed" };
    }
    if (!fresh) return { ok: false, error: "Card not found" };

    const unit = fresh.rewardType; // "points" | "cashback"
    const current = unit === "points" ? fresh.currentPoints : fresh.currentCashBack;
    const target = unit === "points" ? Math.round(scrapedNumber) : Math.round(scrapedNumber * 100) / 100;
    const delta = target - current;

    if (delta === 0) return { ok: true, noop: true, target, current };

    const type = delta > 0 ? "earn" : "redeem";
    const amount = Math.abs(delta);
    try {
        await Tracker.postTransaction(apiBase, token, {
            cardId: card.id,
            type,
            unit,
            amount,
            note: `Auto-sync from ${fresh.issuer} portal`,
        });
    } catch (err) {
        return { ok: false, error: err.message || "Transaction failed" };
    }
    return { ok: true, target, current, delta, type };
}

async function notify(title, message) {
    try {
        await chrome.notifications.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
            title,
            message,
        });
    } catch {
        // Notifications may fail without an icon; the popup also shows status.
    }
}

// ---- capture session lifecycle ------------------------------------------

async function startCapture({ card, mode = "auto" }) {
    const { portalOverrides } = await getState(["portalOverrides"]);
    const portal = await resolvePortalForCard(card, portalOverrides);
    if (!portal) {
        return { ok: false, error: `No portal mapping for ${card.issuer}. Use Configure to set one.` };
    }

    // Hard guard: never open chrome.tabs.create with a null url — that
    // silently opens the New Tab page and leaves the user staring at a
    // blank "Opening …" status. Surface a clear error instead.
    const targetUrl = portal.loginUrl || portal.pointsUrlHint || portal.capturedUrl || null;
    if (!targetUrl) {
        return { ok: false, error: `No portal URL configured for ${card.issuer}. Use Configure to set one.` };
    }

    const tab = await chrome.tabs.create({
        url: targetUrl,
        active: true,
    });

    const session = {
        cardId: card.id,
        cardName: card.displayName,
        issuer: card.issuer,
        unit: card.rewardType || null,
        tabId: tab.id,
        matchUrl: portal.matchUrl,
        selector: portal.selector,
        pointsUrlHint: portal.pointsUrlHint || null,
        regex: portal.regex || null,
        mode,                      // "auto" = scrape on navigation; "configure" = wait for picker
        startedAt: Date.now(),
        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
        status: "opening",
        statusLabel: `Opening ${card.issuer} portal…`,
        currentUrl: targetUrl,
        tabState: "loading",
    };
    await setState({ captureSession: session });
    return { ok: true, session };
}

async function cancelCapture() {
    await setState({ captureSession: null });
    return { ok: true };
}

// ---- Card-level offers sync (Chase Offers, Amex Offers, etc.) ----------
//
// Heuristic in-page scraper. Issuer offer DOMs change every few weeks,
// so we deliberately avoid hard-coded class names: we walk the live DOM
// for tiles that contain BOTH a "$X back" / "X% back" / "Earn N pts"
// badge AND a merchant name, then merge duplicates.
//
// Returns: [{ merchant, title, valueCents, minSpendCents, discountType,
//             discountValue, description, expiresAt, merchantUrl, category }]
function offersPageScraper() {
    // Smart category classifier — keyword-based against the merchant
    // name + tile text + the merchant's URL host. Order matters: more
    // specific buckets are checked first (e.g. "Whole Foods" -> grocery
    // before "foods"-as-dining). Server-side enum is:
    //   dining | travel | streaming | retail | grocery | gas |
    //   entertainment | other
    const CATEGORY_RULES = [
        ["grocery",       /\b(whole\s*foods|trader\s*joe|kroger|safeway|publix|wegmans|aldi|sprouts|albertsons|harris\s*teeter|h-?e-?b|food\s*lion|stop\s*&?\s*shop|giant|fresh\s*market|grocery|supermarket|instacart|gopuff|shipt)\b/i],
        ["gas",           /\b(shell|chevron|exxon|mobil|bp|76|arco|valero|conoco|phillips\s*66|sunoco|citgo|marathon|texaco|gas\s*station|fuel|ev\s*charging|electrify\s*america|chargepoint)\b/i],
        ["streaming",     /\b(netflix|hulu|disney\+?|disney\s*plus|hbo|max|peacock|paramount\+?|apple\s*tv|spotify|pandora|tidal|youtube\s*(tv|premium|music)|sirius\s*xm|audible|kindle\s*unlimited|streaming|prime\s*video)\b/i],
        ["travel",        /\b(hilton|marriott|hyatt|ihg|wyndham|choice\s*hotels|airbnb|vrbo|expedia|booking\.com|priceline|kayak|orbitz|hotels\.com|delta|united|american\s*airlines|southwest|jetblue|alaska\s*airlines|spirit\s*airlines|frontier|lufthansa|emirates|qatar|british\s*airways|air\s*france|klm|iberia|cathay|ana|hawaiian\s*airlines|amtrak|hertz|avis|enterprise|budget|national\s*car|sixt|turo|uber|lyft|cruise|carnival|royal\s*caribbean|norwegian|princess|disney\s*cruise|hotel|airline|airport|flight|tsa|global\s*entry|clear)\b/i],
        ["dining",        /\b(starbucks|dunkin|peets|chipotle|cava|sweetgreen|panera|chick-?fil-?a|mcdonald|wendy|burger\s*king|taco\s*bell|kfc|popeyes|five\s*guys|shake\s*shack|in-?n-?out|domino|papa\s*john|pizza\s*hut|little\s*caesars|olive\s*garden|outback|texas\s*roadhouse|chili|applebee|red\s*lobster|cheesecake\s*factory|red\s*robin|ihop|denny|cracker\s*barrel|panda\s*express|jersey\s*mike|jimmy\s*john|subway|firehouse\s*subs|qdoba|moe|chipotle|p\.?f\.?\s*chang|benihana|nobu|morton|capital\s*grille|ruth's\s*chris|fogo\s*de\s*chao|seamless|grubhub|doordash|ubereats|uber\s*eats|caviar|postmates|opentable|resy|toast\s*tab|goldbelly|restaurant|coffee|caf[eé]|bar(?:\b|s\b)|tavern|bistro|grill|pizzeria|bakery|deli|brewery|food)\b/i],
        ["entertainment", /\b(amc|regal\s*cinemas|cinemark|imax|movie|theatre|theater|cinemas?|ticketmaster|stubhub|live\s*nation|seatgeek|vivid\s*seats|gametime|fandango|axs|broadway|opera|symphony|concert|festival|six\s*flags|disneyland|disney\s*world|universal\s*studios|sea\s*world|cedar\s*point|busch\s*gardens|knott|dave\s*&?\s*buster|topgolf|bowling|arcade|escape\s*room|equinox|peloton|soulcycle|orange\s*theory|planet\s*fitness|gym|fitness|yoga|class\s*pass|nintendo|playstation|xbox|steam|epic\s*games|riot|blizzard|ea\s*sports|rockstar|spa|massage)\b/i],
        ["retail",        /\b(amazon|walmart|target|costco|sam's\s*club|bj's|best\s*buy|home\s*depot|lowe's|menards|ace\s*hardware|true\s*value|macy|nordstrom|bloomingdale|saks|neiman\s*marcus|kohl|jcpenney|tj\s*maxx|marshalls|home\s*goods|ross|burlington|ulta|sephora|bath\s*&?\s*body\s*works|victoria's\s*secret|gap|old\s*navy|banana\s*republic|j\.?\s*crew|express|h&m|zara|uniqlo|forever\s*21|nike|adidas|under\s*armour|lululemon|patagonia|the\s*north\s*face|columbia|rei|dick's\s*sporting|academy\s*sports|cabela|bass\s*pro|petco|petsmart|chewy|barnes\s*&?\s*noble|staples|office\s*depot|ikea|wayfair|west\s*elm|crate\s*&?\s*barrel|pottery\s*barn|williams[- ]sonoma|walgreens|cvs|rite\s*aid|dollar\s*tree|dollar\s*general|family\s*dollar|five\s*below|etsy|ebay|shopify|shop|store|outlet|boutique)\b/i],
    ];
    function classifyCategory(merchant, tileText, merchantUrl) {
        const hay = [
            String(merchant || ""),
            String(merchantUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
            String(tileText || "").slice(0, 400),
        ].join(" \n ");
        for (const [cat, re] of CATEGORY_RULES) {
            if (re.test(hay)) return cat;
        }
        return "other";
    }

    function parseMoney(s) {
        const m = String(s || "").replace(/[,\s\u00A0]/g, "").match(/\$\s*(\d+(?:\.\d{1,2})?)/);
        return m ? Math.round(parseFloat(m[1]) * 100) : null;
    }
    function parsePct(s) {
        const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*%/);
        return m ? parseFloat(m[1]) : null;
    }
    function parseDate(s) {
        const m = String(s || "").match(/(?:expires?|exp(?:\.|ires)?\s*(?:on)?|valid through|good through|by)\s*([A-Za-z]{3,9}\.?\s*\d{1,2}(?:,\s*\d{4})?)/i);
        if (!m) return null;
        const d = new Date(m[1]);
        if (Number.isNaN(d.getTime())) return null;
        // If no year was given, assume year so the expiration is in the future.
        if (!/\d{4}/.test(m[1]) && d < new Date()) d.setFullYear(d.getFullYear() + 1);
        return d.toISOString();
    }
    function parseMinSpend(s) {
        // "Spend $50+", "on purchases of $30 or more"
        const m = String(s || "").match(/(?:spend|purchases? of|on)\s*\$\s*(\d+(?:\.\d{1,2})?)/i);
        return m ? Math.round(parseFloat(m[1]) * 100) : null;
    }

    // Visit shadow roots too — Chase wraps things in custom elements.
    function* walk(root) {
        const stack = [root];
        while (stack.length) {
            const el = stack.pop();
            if (!el) continue;
            yield el;
            if (el.shadowRoot) stack.push(el.shadowRoot);
            const kids = el.children;
            if (kids && kids.length) {
                for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
            }
        }
    }

    // Tile candidate = a contiguous block whose text simultaneously
    // contains a back/earn pattern AND looks like a merchant name (a
    // short capitalized phrase). We score the smallest enclosing
    // ancestor to avoid sweeping whole page sections.
    //
    // The badge regex needs to cover every shape issuers throw at us:
    //   - "$10 back" / "$10 cash back" / "$10.00 back"
    //   - "5% back" / "10% cash back"
    //   - "Earn 5,000 bonus points" / "Earn 2x miles"
    //   - Chase's newer offer-hub also renders "$15 Cash Back" without
    //     the word "back" being adjacent in some tile variants, so we
    //     accept "cash back" within ~30 chars of the dollar amount too.
    const BADGE_RE = /(\$\s?\d+(?:[.,]\d{1,2})?\s*(?:cash\s*)?back|\d+(?:\.\d+)?\s*%\s*(?:cash\s*)?back|earn\s+[\d,]+\s*(?:bonus\s*)?(?:points|pts|miles|x\s*(?:points|pts|miles)))/i;
    const tiles = [];
    const seenNodes = new Set();
    for (const el of walk(document.body || document)) {
        if (!el || el.nodeType !== 1) continue;
        const text = (el.innerText || el.textContent || "").trim();
        if (!text || text.length > 400) continue; // tile-sized text only
        const badge = text.match(BADGE_RE);
        if (!badge) continue;
        // Find smallest tile-like ancestor for this match.
        let tile = el;
        while (tile.parentElement) {
            const pTxt = (tile.parentElement.innerText || "").trim();
            if (pTxt.length > 600) break;
            if (!BADGE_RE.test(pTxt) || pTxt === text) break;
            tile = tile.parentElement;
            if (tile === document.body) break;
        }
        if (seenNodes.has(tile)) continue;
        seenNodes.add(tile);

        const tileText = (tile.innerText || "").trim();
        // Merchant heuristic: first line that is NOT the badge, NOT "Add to card",
        // NOT a date line, between 2 and 60 chars.
        //
        // Chase / Amex offer tiles commonly *lead* with a small decoration
        // label like "New", "Hot", "Featured", "Trending", "Just added",
        // "Limited time", "Recommended", "Popular". Without filtering those
        // we'd pick "New" as the merchant — which is exactly what users
        // were seeing in the offers list. Treat them as ignorable.
        const lines = tileText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        const ignore = /(add to card|added|expires?|exp\b|terms|details|see |learn more|activate|enroll)/i;
        const decoration = /^(new|hot|featured|trending|just added|limited[- ]time|popular|recommended|exclusive|back\s*soon|ending soon|coming soon|sponsored|deal of the (day|week))$/i;
        let merchant = null;
        for (const ln of lines) {
            if (BADGE_RE.test(ln)) continue;
            if (ignore.test(ln)) continue;
            if (decoration.test(ln)) continue;
            if (ln.length < 2 || ln.length > 60) continue;
            // Skip lines that are mostly digits or punctuation.
            if (!/[A-Za-z]/.test(ln)) continue;
            // Skip pure "New" / "Hot" even with trailing punctuation.
            if (decoration.test(ln.replace(/[.,!\u2022\-:]+$/, "").trim())) continue;
            merchant = ln;
            break;
        }
        if (!merchant) continue;

        const usd = parseMoney(badge[0]);
        const pct = parsePct(badge[0]);
        const ptsMatch = badge[0].match(/earn\s+([\d,]+)/i);

        let discountType = "statement_credit";
        let discountValue = 0;
        let valueCents = 0;
        if (usd != null) {
            discountType = "statement_credit";
            discountValue = usd;
            valueCents = usd;
        } else if (pct != null) {
            discountType = "pct_back";
            discountValue = pct;
            // Estimate value at typical $50 spend if no min-spend is shown.
            const min = parseMinSpend(tileText);
            valueCents = Math.round(((min || 5000) * pct) / 100);
        } else if (ptsMatch) {
            discountType = "bonus_points";
            discountValue = parseInt(ptsMatch[1].replace(/,/g, ""), 10);
            valueCents = Math.round(discountValue * 1.5); // ~1.5c/pt rough
        }

        const minSpendCents = parseMinSpend(tileText) || 0;
        const expiresAt = parseDate(tileText);

        // Optional merchant link.
        let merchantUrl = "";
        const a = tile.querySelector && tile.querySelector("a[href]");
        if (a) merchantUrl = a.href || "";

        tiles.push({
            merchant: merchant.slice(0, 120),
            title: `${merchant} – ${badge[0]}`.slice(0, 200),
            description: tileText.slice(0, 500),
            valueCents,
            minSpendCents,
            discountType,
            discountValue,
            expiresAt,
            merchantUrl,
            category: classifyCategory(merchant, tileText, merchantUrl),
        });
    }

    // Dedupe by (merchant + badge) — tiles often repeat in carousels.
    const dedupe = new Map();
    for (const t of tiles) {
        const key = `${t.merchant.toLowerCase()}|${t.discountType}|${t.discountValue}`;
        if (!dedupe.has(key)) dedupe.set(key, t);
    }
    return Array.from(dedupe.values());
}

const OFFER_PORTALS = {
    chase: {
        // Chase's current Merchant Offers hub. Without an accountId it
        // either redirects to the user's first eligible card or shows a
        // small account picker; the polling scraper survives both
        // because it re-reads the live DOM on every tick. Per-card
        // accountId overrides (when we have one) are passed via
        // syncOffersForCard's `card.chaseAccountId` field.
        loginUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub",
        matchUrl: "https://*.chase.com/*",
    },
    amex: {
        loginUrl: "https://global.americanexpress.com/offers/eligible",
        matchUrl: "https://*.americanexpress.com/*",
    },
    "bank of america": {
        loginUrl: "https://secure.bankofamerica.com/customer-deals/redirect/customer-deals.go",
        matchUrl: "https://*.bankofamerica.com/*",
    },
};

// Run the expansion pass (click "show more", scroll virtualized lists)
// and then the offer-tile extractor on a given tab. Returns offers[] or
// []. Shared by the dedicated portal-opening flow and the smart
// "Sync tab" flow so they behave identically once a tab is on screen.
async function scrapeOffersFromTab(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: async () => {
                function isVisible(el) {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }
                const expandSelectors = [
                    "button",
                    "a[role='button']",
                    "[data-testid*='more' i]",
                    "[aria-label*='more' i]",
                ];
                const wantText = /\b(show|see|load|view)\s+(more|all)|add more offers|more offers/i;
                const clicked = new Set();
                for (let pass = 0; pass < 4; pass++) {
                    const candidates = document.querySelectorAll(expandSelectors.join(","));
                    let did = false;
                    for (const el of candidates) {
                        if (clicked.has(el)) continue;
                        const txt = (el.innerText || el.textContent || "").trim();
                        if (!wantText.test(txt)) continue;
                        if (!isVisible(el)) continue;
                        try { el.click(); did = true; clicked.add(el); } catch { /* noop */ }
                    }
                    if (!did) break;
                    await new Promise((r) => setTimeout(r, 600));
                }
                const containers = [document.scrollingElement || document.documentElement];
                for (const el of document.querySelectorAll("*")) {
                    const cs = getComputedStyle(el);
                    if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 100) {
                        containers.push(el);
                    }
                }
                for (const c of containers) {
                    const step = Math.max(400, Math.floor((c.clientHeight || 800) * 0.8));
                    const max = c.scrollHeight || 0;
                    for (let y = 0; y <= max + step; y += step) {
                        try { c.scrollTop = y; } catch { /* noop */ }
                        await new Promise((r) => setTimeout(r, 180));
                    }
                    try { c.scrollTop = 0; } catch { /* noop */ }
                }
                await new Promise((r) => setTimeout(r, 400));
            },
        });
    } catch { /* best-effort; never block the scrape */ }

    let results = [];
    try {
        results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: offersPageScraper,
        });
    } catch { return []; }

    let best = [];
    for (const r of results) {
        const arr = Array.isArray(r?.result) ? r.result : [];
        if (arr.length > best.length) best = arr;
    }
    return best;
}

// Upload a scraped offers[] for a card and reflect the result in the
// capture session so the popup banner shows synced/error state. Returns
// the same envelope the popup expects ({ ok, created, updated, received, ... }).
async function uploadOffersForCard(card, offers, apiBase, token) {
    try {
        const resp = await Tracker.bulkUpsertOffers(apiBase, token, {
            cardId: card.id,
            source: "extension",
            offers,
        });
        const session = {
            kind: "offers",
            cardId: card.id,
            cardName: card.displayName,
            issuer: card.issuer,
            status: "synced",
            statusLabel: `Synced ${resp.received || offers.length} ${card.issuer || "card"} offers`,
            lastScrape: { offers: offers.length, at: Date.now() },
            lastError: null,
            startedAt: Date.now(),
            expiresAt: Date.now() + 2 * 60 * 1000,
        };
        await setState({ captureSession: session });
        notify("Fins Sync", `${card.displayName}: pulled ${resp.received || offers.length} offers (${resp.created || 0} new)`);
        return { ok: true, ...resp };
    } catch (err) {
        const msg = err?.message || "Failed to upload offers";
        await setState({ captureSession: { kind: "offers", cardId: card.id, status: "error", lastError: msg, startedAt: Date.now() } });
        return { ok: false, error: msg };
    }
}

async function syncOffersForCard(card) {
    if (!card || !card.id) return { ok: false, error: "Missing card" };
    const { apiBase, token } = await getState(["apiBase", "token"]);
    if (!token) return { ok: false, error: "Not logged in" };

    const issuer = String(card.issuer || "").toLowerCase().trim();
    const portal = OFFER_PORTALS[issuer];

    // Fallback path for issuers without a known offers portal: scrape
    // whatever is on the user's currently active tab. The smart "Sync
    // tab" button is the preferred entry point for these, but exposing
    // "Sync offers" on every card means a user can also drive it from
    // the offers page they're already looking at.
    if (!portal) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!active?.id) {
            return { ok: false, error: `Open your ${card.issuer || "issuer"} offers page in a tab first, then click Sync offers again.` };
        }
        const offers = await scrapeOffersFromTab(active.id);
        if (!offers.length) {
            return { ok: false, error: "Couldn't find any offers on the current tab. Open your offers list and try again." };
        }
        return await uploadOffersForCard(card, offers, apiBase, token);
    }

    // Chase's offer-hub URL accepts an optional ?accountId=... that
    // jumps straight to that card's offers (no picker). We fall back
    // to the generic URL when the card record doesn't carry one.
    let openUrl = portal.loginUrl;
    if (issuer === "chase" && card.chaseAccountId) {
        openUrl = `https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub?accountId=${encodeURIComponent(card.chaseAccountId)}`;
    }

    // Mark a lightweight session so the popup shows a banner.
    const session = {
        kind: "offers",
        cardId: card.id,
        cardName: card.displayName,
        issuer: card.issuer,
        status: "opening",
        statusLabel: `Opening ${card.issuer} offers…`,
        currentUrl: openUrl,
        tabState: "loading",
        startedAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
    };
    await setState({ captureSession: session });

    let tab;
    try {
        tab = await chrome.tabs.create({ url: openUrl, active: true });
    } catch (err) {
        await setState({ captureSession: { ...session, status: "error", lastError: err.message || "Couldn't open portal" } });
        return { ok: false, error: err.message || "Couldn't open portal" };
    }

    // Wait up to 4 minutes for the user to sign in and land on the offers page,
    // then poll the live tab for offers tiles. Resolve as soon as we get any.
    const deadline = Date.now() + 4 * 60 * 1000;
    let offers = [];
    let lastErr = null;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3500));
        let tabInfo;
        try { tabInfo = await chrome.tabs.get(tab.id); }
        catch { lastErr = "User closed the tab"; break; }

        if (!tabInfo || tabInfo.status !== "complete") continue;

        // Update banner with current url.
        await setState({
            captureSession: {
                ...session,
                status: "watching",
                statusLabel: `Reading ${card.issuer} offers…`,
                currentUrl: tabInfo.url,
                tabState: "watching",
            },
        });

        // Attempt scrape in all frames via the shared helper. Returns
        // [] if Chase hasn't mounted any tiles yet (e.g. user still on
        // a sign-in screen), in which case we just loop again.
        let best = [];
        try {
            best = await scrapeOffersFromTab(tab.id);
        } catch (err) {
            lastErr = err?.message || String(err);
            continue;
        }

        if (best.length) {
            offers = best;
            break;
        }

        // Still on a sign-in page? Keep the banner friendly.
        const isAuth = await tabLooksLikeAuthPage(tab.id).catch(() => false);
        if (isAuth) {
            await setState({
                captureSession: {
                    ...session,
                    status: "awaiting-login",
                    statusLabel: `Sign in to ${card.issuer} — we'll grab your offers automatically.`,
                    currentUrl: tabInfo.url,
                },
            });
        }
    }

    if (!offers.length) {
        const msg = lastErr || "Couldn't find any offers on that page. Open your offers list and try again.";
        await setState({ captureSession: { ...session, status: "error", lastError: msg } });
        return { ok: false, error: msg };
    }

    return await uploadOffersForCard(card, offers, apiBase, token);
}

// Tabs where we have an in-page DOM watcher actively scraping. Value is
// the URL we armed it for so we can re-arm on SPA route changes.
const activeObservers = new Map(); // tabId -> { url, startedAt }
// Tabs where the auto-detect prompt is already shown.
const promptInjectedTabs = new Map(); // tabId -> origin

// Injected into the target page in MAIN world. Watches the DOM for up to
// `timeoutMs` and resolves with the first scrape that produces a usable
// number. This is what lets us survive single-page-app banking portals
// where the points value only appears after a fetch+render cycle long\n// after `tabs.onUpdated complete` fires.
function pageWatcher(extractorSrc, selectorList, regexStr, unitHint, timeoutMs) {
    // Reuse a single watcher per page; cancel the previous one if any.
    try { if (window.__finsWatcherCancel) window.__finsWatcherCancel(); } catch { /* noop */ }

    // eslint-disable-next-line no-new-func
    const extractor = new Function("selectorList", "regexStr", "unitHint",
        `return (${extractorSrc})(selectorList, regexStr, unitHint);`);

    // Detects whether the current page is showing a sign-in / MFA form
    // instead of the post-auth dashboard. Used so the background never
    // says "couldn't find points" while the user is still authenticating.
    function looksLikeAuthPage() {
        try {
            // Password input is the single strongest signal.
            if (document.querySelector('input[type="password"]:not([disabled])')) return true;
            // SSO / OAuth / MFA challenge URLs.
            if (/\/(auth|login|logon|signin|sign-in|sso|oauth|mfa|otp|challenge|verify)(\W|$)/i.test(location.pathname + location.hash)) {
                // Confirm with a UI cue (button or heading) — pure URL match
                // is too eager (e.g. Chase's dashboard URL contains "auth").
                const txt = (document.body && document.body.innerText || "").slice(0, 2000).toLowerCase();
                if (/sign in|log in|log on|username|user id|verification code|enter the code|two-step|two factor|continue to your account/.test(txt)) {
                    return true;
                }
            }
            // Visible "sign in" / "log on" submit button.
            const btns = document.querySelectorAll('button, [role="button"], input[type="submit"]');
            for (const b of btns) {
                const t = ((b.innerText || b.value || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
                if (!t) continue;
                if (/^(sign in|log in|log on|sign on|continue)$/.test(t)) {
                    // Ignore tiny / hidden buttons.
                    const r = b.getBoundingClientRect();
                    if (r.width >= 40 && r.height >= 16) return true;
                }
            }
        } catch (_) { /* noop */ }
        return false;
    }

    return new Promise((resolve) => {
        const deadline = Date.now() + (timeoutMs || 90000);
        let done = false;
        let timer = null;
        let obs = null;
        let lastValue = null;
        let lastValueAt = 0;
        const STABLE_MS = 1200;

        function finish(value) {
            if (done) return;
            done = true;
            try { obs && obs.disconnect(); } catch { /* noop */ }
            try { clearTimeout(timer); } catch { /* noop */ }
            window.__finsWatcherCancel = null;
            resolve(value || null);
        }

        function parseNum(s) {
            if (!s) return null;
            const m = String(s).match(/-?\d[\d,]*(?:\.\d+)?/);
            if (!m) return null;
            const n = Number(m[0].replace(/,/g, ""));
            return Number.isFinite(n) ? n : null;
        }

        function tryOnce() {
            if (done) return;
            try {
                const v = extractor(selectorList, regexStr, unitHint);
                if (v && v.text) {
                    const n = parseNum(v.text);
                    if (n != null) {
                        if (lastValue === n) {
                            if (Date.now() - lastValueAt >= STABLE_MS) {
                                finish(v);
                                return;
                            }
                        } else {
                            lastValue = n;
                            lastValueAt = Date.now();
                        }
                    }
                }
            } catch (_) { /* keep watching */ }
            if (Date.now() > deadline) {
                // Timed out without finding a stable number. If we're
                // looking at a sign-in / MFA page, surface a special
                // signal so the background keeps the session alive
                // instead of declaring an error.
                if (looksLikeAuthPage()) {
                    finish({ __awaitingLogin: true });
                    return;
                }
                finish(null);
            }
        }

        window.__finsWatcherCancel = () => finish(null);

        tryOnce();
        const poll = setInterval(() => {
            if (done) { clearInterval(poll); return; }
            tryOnce();
        }, 700);

        try {
            obs = new MutationObserver(() => { tryOnce(); });
            obs.observe(document.documentElement, {
                childList: true, subtree: true, characterData: true,
            });
        } catch { /* fall back to polling */ }

        timer = setTimeout(() => { clearInterval(poll); tryOnce(); finish(null); }, timeoutMs || 90000);
    });
}

async function watchTabForExtraction(tabId, selector, regex, unitHint, timeoutMs = 90000) {
    const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: pageWatcher,
        args: [pageExtractor.toString(), selector, regex || null, unitHint || null, timeoutMs],
    });
    let best = null;
    let anyAwaitingLogin = false;
    for (const r of results) {
        const v = r?.result;
        if (!v) continue;
        if (v.__awaitingLogin) { anyAwaitingLogin = true; continue; }
        if (!best) { best = v; continue; }
        if (best.via === "heuristic" && v.via !== "heuristic") { best = v; continue; }
        if (best.via === "heuristic" && v.via === "heuristic" && (v.score || 0) > (best.score || 0)) {
            best = v;
        }
    }
    if (best) {
        console.log("[finstracker] watcher picked:", {
            text: best.text, via: best.via, selector: best.selector,
            score: best.score, candidates: best.candidates,
        });
        return best;
    }
    if (anyAwaitingLogin) return { __awaitingLogin: true };
    return null;
}

// Quick out-of-band probe: ask the live tab whether it currently shows
// any sign-in / MFA inputs. Used as a fallback when the watcher times
// out without returning anything — keeps us from flashing an error
// banner while the user is mid-login.
async function tabLooksLikeAuthPage(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: () => {
                try {
                    if (document.querySelector('input[type="password"]:not([disabled])')) return true;
                    if (document.querySelector('input[autocomplete*="password" i]')) return true;
                    const userInput = document.querySelector(
                        'input[name*="user" i], input[autocomplete*="username" i], input[id*="user" i]'
                    );
                    if (userInput) {
                        // Username alone is weak — only count it on a small page
                        // with no large content area (true login forms).
                        const txt = (document.body?.innerText || "").length;
                        if (txt < 1500) return true;
                    }
                    return false;
                } catch { return false; }
            },
        });
        return results.some((r) => r?.result === true);
    } catch { return false; }
}

async function tryCaptureOnTab(tabId, url) {
    const { captureSession } = await getState(["captureSession"]);
    if (!captureSession) return;
    if (captureSession.tabId !== tabId) return;
    if (Date.now() > captureSession.expiresAt) {
        await setState({ captureSession: null });
        return;
    }
    if (!urlMatches(captureSession.matchUrl, url)) {
        // Still on a login / OAuth hop on the same tab — keep the session
        // alive and show a friendly status. Once the user reaches the
        // post-login page that matches, this listener fires again.
        await setState({
            captureSession: { ...captureSession, status: "awaiting-login", statusLabel: "Sign in to your bank \u2026", currentUrl: url, tabState: "loading" },
        });
        return;
    }
    if (captureSession.mode === "configure") return; // user-driven via picker

    // Already watching this exact URL? Don't restart \u2014 the observer
    // will resolve when the DOM settles.
    const cur = activeObservers.get(tabId);
    if (cur && cur.url === url && (Date.now() - cur.startedAt) < 120000) return;
    activeObservers.set(tabId, { url, startedAt: Date.now() });

    await setState({
        captureSession: { ...captureSession, status: "watching", statusLabel: `Reading ${captureSession.cardName}\u2026`, currentUrl: url, tabState: "watching" },
    });

    let scraped;
    try {
        scraped = await watchTabForExtraction(tabId, captureSession.selector, captureSession.regex, captureSession.unit, 120000);
    } catch (err) {
        console.warn("watcher failed", err);
        activeObservers.delete(tabId);
        return;
    }
    activeObservers.delete(tabId);
    if (!scraped) {
        // No frame returned anything — most likely the page never
        // settled. Before declaring an error, probe the live DOM for
        // sign-in/MFA inputs; if present, stay in awaiting-login so
        // the user knows to finish signing in instead of seeing a
        // confusing "couldn't find points" error on the login page.
        const isAuth = await tabLooksLikeAuthPage(tabId).catch(() => false);
        if (isAuth) {
            await setState({
                captureSession: {
                    ...captureSession,
                    status: "awaiting-login",
                    statusLabel: "Sign in and we'll keep watching\u2026",
                    lastError: null,
                    currentUrl: url,
                },
            });
            return;
        }
        await setState({
            captureSession: { ...captureSession, status: "error", lastError: "Couldn't find points on this page. Open the rewards page or use Pick element.", currentUrl: url },
        });
        return;
    }
    if (scraped.__awaitingLogin) {
        // Watcher timed out specifically on a login/MFA frame. Keep
        // the session alive and let the user finish authenticating.
        await setState({
            captureSession: {
                ...captureSession,
                status: "awaiting-login",
                statusLabel: "Sign in and we'll keep watching\u2026",
                lastError: null,
                currentUrl: url,
            },
        });
        return;
    }
    const value = parseNumber(scraped.text);
    if (value == null) {
        await setState({
            captureSession: { ...captureSession, status: "error", lastError: `Found \u201C${scraped.text}\u201D but no number`, currentUrl: url },
        });
        return;
    }

    const card = { id: captureSession.cardId, issuer: captureSession.issuer, displayName: captureSession.cardName };
    const result = await syncCardBalance(card, value);

    // Auto-learn: if the heuristic produced a stable, well-formed
    // number that the backend accepted, remember the resolved selector
    // so the next sync uses the fast configured-selector path instead
    // of re-scoring the whole page. Only saves for "heuristic" hits;
    // selector-matched hits already have a working selector. Never
    // overwrites an existing user-picked override.
    try {
        if (result.ok && scraped.via === "heuristic" && scraped.selector) {
            const { portalOverrides } = await getState(["portalOverrides"]);
            const existing = portalOverrides && portalOverrides[captureSession.cardId];
            if (!existing || existing.source !== "user-picker") {
                const origin = (() => { try { return new URL(url).origin + "/*"; } catch { return captureSession.matchUrl; } })();
                const learned = {
                    matchUrl: origin,
                    capturedUrl: url,
                    selector: scraped.selector,
                    regex: null,
                    source: "auto-learned",
                    learnedAt: Date.now(),
                };
                await setState({
                    portalOverrides: { ...(portalOverrides || {}), [captureSession.cardId]: learned },
                });
                console.log("[finstracker] auto-learned selector for", captureSession.cardName, learned);
            }
        }
    } catch (err) { console.warn("auto-learn failed", err); }

    await setState({
        captureSession: {
            ...captureSession,
            status: result.ok ? "synced" : "error",
            lastScrape: { value, text: scraped.text, selector: scraped.selector, at: Date.now() },
            lastError: result.ok ? null : result.error,
            currentUrl: url,
        },
    });
    if (result.ok) {
        notify(
            "Fins Sync",
            result.noop
                ? `${card.displayName}: already up to date (${value})`
                : `${card.displayName}: synced to ${value} (${result.type === "earn" ? "+" : "-"}${Math.abs(result.delta)})`
        );
    } else {
        notify("Fins Sync \u2014 sync failed", result.error);
    }
}

// ---- auto-detect on known portals (when no active session) ---------------
//
// Behavior change: instead of silently scraping, we now inject a small
// floating prompt onto the portal page that lets the user confirm a sync
// in one click. This makes the extension feel "present" (the original
// complaint: "the chrome extension should automatically appear when they
// are going to a banking portal").

const dismissedOrigins = new Map(); // origin -> timestamp; in-memory only
const PROMPT_DISMISS_TTL_MS = 1000 * 60 * 30; // 30 minutes

async function autoDetectVisit(tabId, url) {
    const { autoDetect, token, captureSession, apiBase, portalOverrides } = await getState([
        "autoDetect", "token", "captureSession", "apiBase", "portalOverrides",
    ]);
    if (!autoDetect || !token || captureSession) {
        await clearBadge(tabId);
        return;
    }
    const portals = await loadPortals();
    const issuers = portals.issuers || portals;
    const match = Object.entries(issuers).find(([_, p]) => urlMatches(p.matchUrl, url));
    if (!match) { await clearBadge(tabId); return; }
    const [issuer] = match;

    let cards;
    try { cards = await Tracker.listCards(apiBase, token); }
    catch { return; }
    if (!Array.isArray(cards)) return;
    const candidates = cards.filter((c) => c.issuer === issuer);
    if (!candidates.length) { await clearBadge(tabId); return; }

    // If user dismissed the prompt for this origin recently, just show a
    // badge so the extension is still discoverable.
    let origin = "";
    try { origin = new URL(url).origin; } catch { /* ignore */ }
    const dismissedAt = origin ? dismissedOrigins.get(origin) : 0;
    const dismissed = dismissedAt && (Date.now() - dismissedAt) < PROMPT_DISMISS_TTL_MS;

    await setBadge(tabId, candidates.length === 1 ? "•" : String(candidates.length));

    if (dismissed) return;
    // Ambiguous (multiple cards) — surface badge + a generic prompt that
    // opens the popup; for single-card case we offer a one-click sync.
    const card = candidates.length === 1 ? candidates[0] : null;
    await injectPrompt(tabId, {
        cardId: card?.id || null,
        cardName: card?.displayName || null,
        issuer,
        rewardType: card?.rewardType || null,
        multiple: candidates.length > 1,
        candidateCount: candidates.length,
    });
}

async function setBadge(tabId, text) {
    try {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2f8568" });
        await chrome.action.setBadgeText({ tabId, text: text || "" });
    } catch { /* ignore */ }
}
async function clearBadge(tabId) {
    try { await chrome.action.setBadgeText({ tabId, text: "" }); }
    catch { /* ignore */ }
}

async function injectPrompt(tabId, payload) {
    // Dedupe: skip if we already injected the prompt for this tab+origin.
    let origin = "";
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url) origin = new URL(tab.url).origin;
    } catch { /* ignore */ }
    const key = origin || String(tabId);
    if (promptInjectedTabs.get(tabId) === key) return;
    promptInjectedTabs.set(tabId, key);
    try {
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: ["content/prompt.css"],
        });
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (p) => { window.__finsPromptPayload = p; },
            args: [payload],
        });
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/prompt.js"],
        });
    } catch (err) {
        // Some pages (chrome://, restricted hosts) reject injection. That's
        // fine — the badge still flags the extension.
        console.warn("prompt injection skipped", err?.message);
        promptInjectedTabs.delete(tabId);
    }
}

// ---- tab navigation listener --------------------------------------------
//
// Two events fire here:
//   - status === "loading" with info.url set: SPA route changes / initial
//     navigation. We use this to (re)arm the DOM-watching scraper so we
//     don't miss client-side route transitions on banking portals.
//   - status === "complete": classic full-page load. We re-run the
//     observer and the auto-detect prompt.

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    const url = info.url || tab?.url;
    if (!url) return;
    if (info.status !== "complete" && !info.url) return;
    try {
        await tryCaptureOnTab(tabId, url);
        if (info.status === "complete") await autoDetectVisit(tabId, url);
    } catch (err) {
        console.warn("tab update handler error", err);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    activeObservers.delete(tabId);
    promptInjectedTabs.delete(tabId);
});

// SPA route changes (pushState / replaceState / hashchange) don't always
// fire chrome.tabs.onUpdated. webNavigation.onHistoryStateUpdated is the
// reliable signal — without it, Chase's dashboard SPA can navigate from
// the login screen into the rewards view without us ever re-arming the
// watcher.
try {
    chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
        if (!details || details.frameId !== 0) return;
        try {
            await tryCaptureOnTab(details.tabId, details.url);
            await autoDetectVisit(details.tabId, details.url);
        } catch (err) {
            console.warn("history-state handler error", err);
        }
    });
} catch (err) {
    console.warn("webNavigation listener unavailable", err?.message);
}

// ---- message API for popup + picker --------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            switch (msg?.type) {
                case "ping":
                    return sendResponse({ ok: true });

                case "login": {
                    try {
                        // Accept both `identifier` (new) and `username` (legacy)
                        // so an older popup build still works against this BG.
                        const id = msg.identifier ?? msg.username;
                        const data = await Tracker.login(msg.apiBase, id, msg.password);
                        await setState({ apiBase: msg.apiBase, token: data.token, user: data.user });
                        return sendResponse({ ok: true, user: data.user });
                    } catch (err) {
                        return sendResponse({ ok: false, error: err.message || "Login failed" });
                    }
                }

                case "signup": {
                    // Signup now requires email verification, which the popup
                    // can't do mid-flow. Redirect users to the web signup
                    // page — popup UI already does this via a link.
                    return sendResponse({
                        ok: false,
                        error: "Please sign up at finstracker.com/signup.html, then log in here.",
                    });
                }

                case "logout":
                    await clearAuth();
                    return sendResponse({ ok: true });

                case "listCards": {
                    const { apiBase, token } = await getState(["apiBase", "token"]);
                    if (!token) return sendResponse({ ok: false, error: "Not logged in" });
                    try {
                        const cards = await Tracker.listCards(apiBase, token);
                        return sendResponse({ ok: true, cards: cards || [] });
                    } catch (err) {
                        return sendResponse({ ok: false, error: err.message || "Failed to list cards" });
                    }
                }

                case "startCapture":
                    return sendResponse(await startCapture({ card: msg.card, mode: msg.mode || "auto" }));

                case "cancelCapture":
                    return sendResponse(await cancelCapture());

                case "syncOffers":
                    return sendResponse(await syncOffersForCard(msg.card));

                case "clearOverride": {
                    const { portalOverrides } = await getState(["portalOverrides"]);
                    if (portalOverrides && msg.cardId && portalOverrides[msg.cardId]) {
                        const next = { ...portalOverrides };
                        delete next[msg.cardId];
                        await setState({ portalOverrides: next });
                    }
                    return sendResponse({ ok: true });
                }

                case "syncFromActiveTab": {
                    // Triggered by popup "Sync tab" — or by the injected
                    // portal prompt (which sends tabId: null and relies
                    // on sender.tab).
                    //
                    // Smart routing: the same button handles BOTH points
                    // dashboards and merchant-offer pages. We inspect
                    // the live tab and dispatch to whichever flow the
                    // DOM looks like. Heuristic:
                    //   1. If the URL clearly screams "offers" (offer /
                    //      deals / merchantOffers in path or hash),
                    //      try the offers scraper first.
                    //   2. Else, try the points extractor first; if it
                    //      finds nothing, fall back to offers scrape.
                    //   3. If neither yields anything, error out.
                    const tabId = msg.tabId || sender?.tab?.id;
                    if (!tabId) return sendResponse({ ok: false, error: "No tab context" });
                    const tab = await chrome.tabs.get(tabId);
                    const url = tab.url || "";
                    const looksLikeOffers = /offer|deals|merchantoffers|customer-deals/i.test(url);
                    const { apiBase, token, portalOverrides } = await getState(["apiBase", "token", "portalOverrides"]);
                    if (!token) return sendResponse({ ok: false, error: "Not logged in" });
                    const portal = await resolvePortalForCard(msg.card, portalOverrides);

                    async function tryOffers() {
                        const offers = await scrapeOffersFromTab(tabId);
                        if (!offers.length) return null;
                        const up = await uploadOffersForCard(msg.card, offers, apiBase, token);
                        if (!up.ok) return up;
                        return { ok: true, kind: "offers", offers: offers.length, created: up.created || 0, updated: up.updated || 0, received: up.received || offers.length };
                    }
                    async function tryPoints() {
                        if (!portal) return null;
                        if (!urlMatches(portal.matchUrl, url)) return null;
                        const scraped = await extractFromTab(tabId, portal.selector, portal.regex, msg.card.rewardType || null);
                        if (!scraped) return null;
                        const value = parseNumber(scraped.text);
                        if (value == null) return { ok: false, error: `Found text "${scraped.text}" but no number` };
                        const result = await syncCardBalance(msg.card, value);
                        return { ...result, kind: "points", scraped: { value, text: scraped.text, selector: scraped.selector } };
                    }

                    const order = looksLikeOffers ? [tryOffers, tryPoints] : [tryPoints, tryOffers];
                    let lastErr = null;
                    for (const fn of order) {
                        try {
                            const r = await fn();
                            if (r) return sendResponse(r);
                        } catch (e) { lastErr = e?.message || String(e); }
                    }
                    return sendResponse({ ok: false, error: lastErr || "Couldn't find points or offers on this tab. Make sure you're on your rewards dashboard or offers page." });
                }

                case "startPickerForCard": {
                    // Triggered by the portal prompt's "Pick element" button.
                    // Reuses the picker on the *current* tab (no new tab opened).
                    const tabId = sender?.tab?.id;
                    if (!tabId) return sendResponse({ ok: false, error: "No tab context" });
                    const { portalOverrides } = await getState(["portalOverrides"]);
                    const portal = await resolvePortalForCard(msg.card, portalOverrides);
                    const tab = await chrome.tabs.get(tabId);
                    const session = {
                        cardId: msg.card.id,
                        cardName: msg.card.displayName,
                        issuer: msg.card.issuer,
                        unit: msg.card.rewardType || null,
                        tabId,
                        matchUrl: portal?.matchUrl || (new URL(tab.url).origin + "/*"),
                        selector: portal?.selector || [],
                        pointsUrlHint: portal?.pointsUrlHint || null,
                        regex: portal?.regex || null,
                        mode: "configure",
                        startedAt: Date.now(),
                        expiresAt: Date.now() + CAPTURE_TIMEOUT_MS,
                        status: "waiting",
                        currentUrl: tab.url || null,
                    };
                    await setState({ captureSession: session });
                    try {
                        await chrome.scripting.insertCSS({
                            target: { tabId, allFrames: true },
                            files: ["content/picker.css"],
                        });
                        await chrome.scripting.executeScript({
                            target: { tabId, allFrames: true },
                            func: () => { try { window.__finsPickerActive = false; } catch { /* noop */ } },
                        });
                        await chrome.scripting.executeScript({
                            target: { tabId, allFrames: true },
                            files: ["content/picker.js"],
                        });
                    } catch (err) {
                        return sendResponse({ ok: false, error: err?.message || "Picker injection failed" });
                    }
                    return sendResponse({ ok: true });
                }

                case "dismissPromptForOrigin": {
                    if (msg.origin) dismissedOrigins.set(msg.origin, Date.now());
                    return sendResponse({ ok: true });
                }

                case "openPicker": {
                    // Inject the visual element picker into the active capture tab.
                    const { captureSession } = await getState(["captureSession"]);
                    if (!captureSession) return sendResponse({ ok: false, error: "No active capture session" });
                    try {
                        await chrome.scripting.insertCSS({
                            target: { tabId: captureSession.tabId, allFrames: true },
                            files: ["content/picker.css"],
                        });
                        await chrome.scripting.executeScript({
                            target: { tabId: captureSession.tabId, allFrames: true },
                            func: () => { try { window.__finsPickerActive = false; } catch { /* noop */ } },
                        });
                        await chrome.scripting.executeScript({
                            target: { tabId: captureSession.tabId, allFrames: true },
                            files: ["content/picker.js"],
                        });
                    } catch (err) {
                        return sendResponse({ ok: false, error: err?.message || "Picker injection failed" });
                    }
                    await chrome.tabs.update(captureSession.tabId, { active: true });
                    return sendResponse({ ok: true });
                }

                case "pickerResult": {
                    // Sent from picker.js after the user clicks an element.
                    const { captureSession, portalOverrides } = await getState([
                        "captureSession", "portalOverrides",
                    ]);
                    if (!captureSession) return sendResponse({ ok: false, error: "No active capture session" });
                    const tab = await chrome.tabs.get(captureSession.tabId);
                    const override = {
                        matchUrl: tab.url ? new URL(tab.url).origin + "/*" : captureSession.matchUrl,
                        capturedUrl: tab.url || null,
                        selector: msg.selector,
                        regex: msg.regex || null,
                        source: "user-picker",
                    };
                    const next = { ...portalOverrides, [captureSession.cardId]: override };
                    await setState({
                        portalOverrides: next,
                        captureSession: {
                            ...captureSession,
                            selector: override.selector,
                            matchUrl: override.matchUrl,
                            regex: override.regex,
                            mode: "auto",
                            capturedUrl: override.capturedUrl,
                            status: "configured",
                        },
                    });
                    // Try an immediate sync now that we know the selector.
                    const value = parseNumber(msg.text);
                    if (value != null) {
                        const card = {
                            id: captureSession.cardId,
                            issuer: captureSession.issuer,
                            displayName: captureSession.cardName,
                        };
                        const result = await syncCardBalance(card, value);
                        return sendResponse({ ok: true, override, sync: result });
                    }
                    return sendResponse({ ok: true, override });
                }

                default:
                    return sendResponse({ ok: false, error: "Unknown message" });
            }
        } catch (err) {
            console.error("background message error", err);
            sendResponse({ ok: false, error: err?.message || String(err) });
        }
    })();
    return true; // async sendResponse
});

// ---- web-bridge auth handoff --------------------------------------------
// finstracker.com/login.html posts the JWT back to the extension after the
// user signs in through the regular web flow (which includes Turnstile,
// Google sign-in, password reset, etc.). The sender is constrained by the
// manifest's `externally_connectable.matches` allowlist, so only our own
// origins can talk to us here.

const ALLOWED_HANDOFF_ORIGINS = [
    "https://finstracker.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
];

function isAllowedHandoffSender(sender) {
    const url = sender?.url || sender?.origin || "";
    if (!url) return false;
    try {
        const u = new URL(url);
        const origin = `${u.protocol}//${u.host}`;
        if (ALLOWED_HANDOFF_ORIGINS.includes(origin)) return true;
        // Also allow any *.finstracker.com subdomain (preview deploys etc.).
        return /(^|\.)finstracker\.com$/i.test(u.hostname) && u.protocol === "https:";
    } catch {
        return false;
    }
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (!isAllowedHandoffSender(sender)) {
            return sendResponse({ ok: false, error: "Forbidden sender" });
        }
        try {
            switch (msg?.type) {
                case "ping":
                    // Lets the web page detect that the extension is installed
                    // and ready to receive a handoff before showing the
                    // "Sign in to extension" CTA.
                    return sendResponse({ ok: true, version: chrome.runtime.getManifest().version });

                case "extensionAuthHandoff": {
                    const { token, user, apiBase } = msg;
                    if (typeof token !== "string" || !token) {
                        return sendResponse({ ok: false, error: "Missing token" });
                    }
                    if (!user || typeof user !== "object") {
                        return sendResponse({ ok: false, error: "Missing user" });
                    }
                    // Pin apiBase to whatever origin the user signed in on,
                    // so the popup talks to the same server that issued the
                    // JWT. Falls back to the sender's origin if not provided.
                    let nextApiBase;
                    if (typeof apiBase === "string" && /^https?:\/\//.test(apiBase)) {
                        nextApiBase = apiBase.replace(/\/$/, "");
                    } else {
                        const u = new URL(sender.url);
                        nextApiBase = `${u.protocol}//${u.host}`;
                    }
                    await setState({ apiBase: nextApiBase, token, user });
                    return sendResponse({ ok: true });
                }

                case "extensionAuthSignOut":
                    await clearAuth();
                    return sendResponse({ ok: true });

                default:
                    return sendResponse({ ok: false, error: "Unknown message" });
            }
        } catch (err) {
            console.error("background external message error", err);
            sendResponse({ ok: false, error: err?.message || String(err) });
        }
    })();
    return true;
});

// Write defaults on first install so the popup has something to render
// before the user touches Settings.
chrome.runtime.onInstalled.addListener(async () => {
    const cur = await chrome.storage.local.get(["apiBase", "portalOverrides"]);
    if (!cur.apiBase) await chrome.storage.local.set({ apiBase: "https://finstracker.com" });

    // Dev convenience: if we're still on the production default AND a
    // local dev server is responding on http://localhost:3000/api/health
    // within 800ms, switch to localhost. End users without a local server
    // get a silent fallback (we keep finstracker.com), so this never
    // affects shipped installs.
    await maybeAutoSwitchToLocalDev();

    // One-time migration for v0.1.7+: an earlier auto-learn build saved
    // portalOverrides without a loginUrl/pointsUrlHint and without a
    // capturedUrl, which made the next sync open chrome.tabs.create
    // with url=undefined (blank New Tab page) instead of the issuer
    // sign-in URL. Drop any auto-learned overrides that don't carry a
    // selector — they get rebuilt automatically on the next successful
    // sync, this time with capturedUrl populated.
    try {
        const overrides = cur.portalOverrides;
        if (overrides && typeof overrides === "object") {
            const cleaned = {};
            let removed = 0;
            for (const [cardId, ov] of Object.entries(overrides)) {
                if (!ov || typeof ov !== "object") { removed++; continue; }
                if (!ov.selector) { removed++; continue; }
                if (ov.source === "auto-learned" && !ov.capturedUrl) { removed++; continue; }
                cleaned[cardId] = ov;
            }
            if (removed > 0) {
                await chrome.storage.local.set({ portalOverrides: cleaned });
                console.log(`[finstracker] migration: removed ${removed} stale portal overrides`);
            }
        }
    } catch (err) {
        console.warn("portalOverrides migration skipped:", err?.message);
    }

    // Open the side panel when the user clicks the toolbar icon — this is
    // what gives us a persistent UI that survives navigation and sign-in.
    try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
    catch (err) { console.warn("sidePanel.setPanelBehavior failed", err); }
});

// Also ensure the behavior is set on service-worker startup (e.g. after
// the worker is reaped and woken on a tab event).
(async () => {
    try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
    catch { /* sidePanel API unavailable in this Chrome version */ }
    // Re-run the dev probe on every service-worker wake-up. Cheap enough
    // (one fetch with an 800ms timeout) and means flipping the dev
    // server on/off is reflected without an extension reload.
    maybeAutoSwitchToLocalDev();
})();

// Probe http://localhost:3000/api/health and, if it answers, switch
// apiBase to it — but only when the user hasn't customized away from
// the production default. Never overrides an explicit user choice and
// never changes the value when localhost is unreachable.
async function maybeAutoSwitchToLocalDev() {
    const LOCAL = "http://localhost:3000";
    const PROD = "https://finstracker.com";
    try {
        const { apiBase } = await chrome.storage.local.get(["apiBase"]);
        // Only auto-switch when on the default prod base (or empty).
        // Any other value is a deliberate user choice — leave it alone.
        if (apiBase && apiBase !== PROD) return;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 800);
        let ok = false;
        try {
            const res = await fetch(`${LOCAL}/api/health`, {
                method: "GET",
                cache: "no-store",
                signal: ctrl.signal,
            });
            ok = res.ok;
        } catch { /* localhost not listening; stay on prod */ }
        finally { clearTimeout(timer); }

        if (ok && apiBase !== LOCAL) {
            await chrome.storage.local.set({ apiBase: LOCAL });
            console.log("[finstracker] dev server detected — switched apiBase to", LOCAL);
        }
    } catch (err) {
        console.warn("[finstracker] dev auto-switch skipped:", err?.message);
    }
}
