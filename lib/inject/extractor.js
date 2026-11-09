// Runs inside issuer pages via chrome.scripting.executeScript, so each function must stay
// self-contained: no imports and no references to anything outside its own body.

// Finds the rewards balance: the configured selectors first, then a scored scan of numbers near
// reward words ("points", "miles", "cash back"). hints = { keywords, cardWords } for this card
// (its program, e.g. "skymiles", and name words, e.g. "sapphire") lift the right number when a
// page shows several balances. Returns { text, selector, via, score } or null.
export function pageExtractor(selectorList, regexStr, unitHint, hints) {
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
    const HINT_WORDS = ((hints && hints.keywords) || []).map((w) => String(w).toLowerCase()).filter((w) => w.length >= 3);
    const CARD_WORDS = ((hints && hints.cardWords) || []).map((w) => String(w).toLowerCase()).filter((w) => w.length >= 4);
    // How many levels up from the number the card's name first appears (-1 if not nearby).
    // The number inside the card's own tile has the smallest distance.
    function cardDistance(el) {
        if (!CARD_WORDS.length) return -1;
        let node = el;
        for (let d = 0; d < 8 && node; d++) {
            const text = (node.innerText || node.textContent || "").toLowerCase();
            if (text.length > 1500) return -1;
            if (CARD_WORDS.some((w) => text.includes(w))) return d;
            node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
        }
        return -1;
    }

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

            // This card's own words: its program next to the number, its name nearby.
            const near = lower + " " + ctx;
            if (HINT_WORDS.some((k) => near.includes(k))) { score += 9; ctxKeyword = true; }
            const cardDepth = cardDistance(el);

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
            // Masked account numbers: "(...1234)", "ending in 1234", "•••• 1234".
            if (/\.{3}\s*\d{4}|ending in\s*\d{4}|[•*x]{2,}\s*\d{4}/i.test(txt)) score -= 20;
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

            candidates.push({ el, n, raw, txt, score, cardDepth });
        }
    }

    candidates.sort((a, b) => b.score - a.score || b.n - a.n);
    // On pages listing several cards, keep to the numbers closest to this card's name.
    // Depth 0 means the number sits in the card's own label ("Sapphire (...9876)"), not a balance.
    const named = candidates.filter((c) => c.cardDepth >= 1 && c.score >= 8);
    const closest = Math.min(...named.map((c) => c.cardDepth));
    const best = (named.length ? named.filter((c) => c.cardDepth === closest) : candidates)[0];
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
