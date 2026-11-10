/* Finstracker page reader. Injected (isolated world) into the tabs where a card's balance is read.
 * Lives in a content script rather than code built at run time, so pages with strict
 * Content-Security-Policy headers (most banks) cannot block it.
 * Exposes window.__finsReader: extract, watch, signInShown, findRewardsLink, highlight, clearHighlight. */
(function () {
    if (window.__finsReader) return;
    let lastFound = null; // element of the last balance found, for highlight()
    let lastScan = []; // scored candidates from the last scan, for suggestions()

    // Finds the rewards balance: the configured selectors first, then a scored scan of numbers near
    // reward words. hints = { keywords, cardWords } for the card being synced.
    function extract(selectorList, regexStr, unitHint, hints) {
        lastScan = [];
        // Never a balance: anything in the page footer or legal text, phone numbers, years and dates
        // ("© 2026", "Member since 2015", "Nov 8, 2026", "1-800-528-4800").
        const LEGAL = /©|\(c\)\s*\d{4}|copyright|all rights reserved|member fdic|equal housing|nmls|terms (and|&) conditions|privacy (policy|statement)/i;
        const PHONE = /\b1[-.\s]?\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;
        const MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(19|20)\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-](19|20)?\d{2}\b|\b(19|20)\d{2}-\d{2}-\d{2}\b/i;
        const SINCE = /\b(since|member since|established|est\.?|founded|as of|updated|in)\s+(19|20)\d{2}\b/i;
        const UNIT_AFTER = /^\s*(pts?|points?|miles?|reward dollars|cash ?back)\b/i;
        function inFooter(el) {
            let node = el;
            for (let d = 0; d < 14 && node; d++) {
                if (node.nodeType === 1) {
                    if (node.tagName === "FOOTER" || node.getAttribute("role") === "contentinfo") return true;
                    const tag = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
                    if (/footer|legal|copyright|disclos|disclaimer/i.test(tag)) return true;
                }
                node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
            }
            return false;
        }
        // Legal text and phone numbers rule out the whole element; dates are cut out of the text, so
        // "98,765 points as of Nov 8, 2026" still reads 98,765.
        const noisyText = (t) => LEGAL.test(t) || PHONE.test(t);
        const DATE_G = new RegExp(MONTH_DATE.source, "gi"), SINCE_G = new RegExp(SINCE.source, "gi");
        const stripDates = (t) => t.replace(DATE_G, " ").replace(SINCE_G, " ").replace(/\s+/g, " ").trim();
        // A bare year ("2026") unless a unit follows it ("2026 points"); "2,026" has a comma and is fine.
        function yearOnly(raw, txt) {
            if (!/^(19[5-9]\d|20\d{2})$/.test(raw)) return false;
            const at = txt.indexOf(raw);
            return !UNIT_AFTER.test(txt.slice(at + raw.length, at + raw.length + 20));
        }
        const KEYWORDS = [
            "membership rewards", "ultimate rewards", "thankyou points",
            "miles", "points", "rewards balance", "rewards", "cash back",
            "cashback", "balance", "reward dollars", "cash rewards",
        ];
        const STRONG_KEYWORDS = [
            "rewards balance", "ultimate rewards", "membership rewards",
            "thankyou points", "go far rewards", "mileage plan",
            "points balance", "miles balance", "cashback bonus", "cash back balance",
            "reward dollars", "available cash back", "cash rewards balance", "available rewards",
            "cash back earned", "rewards available",
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
                if (node === document.body || node === document.documentElement) return -1; // not the whole page (or our own notes)
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
                if (unitHint === "points" && /[$€£]\s*-?\d/.test(txt)) continue; // a dollar amount is not points
                if (inFooter(n) || noisyText(txt)) continue;
                const clean = stripDates(txt);
                const first = (clean.match(/-?\d[\d,]*(?:\.\d+)?/) || [""])[0];
                if (!first || yearOnly(first, clean)) continue;
                if (regexStr) {
                    try {
                        const rx = new RegExp(regexStr);
                        const m = txt.match(rx);
                        if (m) {
                            lastFound = n;
                            return {
                                text: m[1] || m[0],
                                html: n.outerHTML.slice(0, 400),
                                selector: sel,
                                via: "selector+regex",
                            };
                        }
                    } catch { /* fall through */ }
                } else if (/\d/.test(clean)) {
                    lastFound = n;
                    return {
                        text: clean,
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
            if (inFooter(el) || noisyText(txt)) continue;

            const nums = stripDates(txt).match(NUMERIC_RX) || [];
            if (!nums.length) continue;

            for (const raw of nums) {
                const n = Number(raw.replace(/,/g, ""));
                if (!Number.isFinite(n)) continue;
                if (yearOnly(raw, txt)) continue;
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
                // A dollar amount is never a points balance.
                if (unitHint === "points" && /[$€£]\s*-?\d/.test(txt)) continue;
                if (unitHint === "cashback" && hasPointsUnit && !hasCurrency) score -= 10;

                // Bonus when the unit token appears immediately after the
                // chosen number, e.g. "3,199 points" or "$45.00 cash back".
                const tail = txt.slice(txt.indexOf(raw) + raw.length, txt.indexOf(raw) + raw.length + 24).toLowerCase();
                if (unitHint === "points" && /^\s*(pts?|points?|miles?)\b/.test(tail)) score += 6;
                if (unitHint === "cashback" && /^\s*(cash|back|cb|usd|dollars?|reward dollars)\b/.test(tail)) score += 4;

                if (unitHint === "cashback") {
                    // Cash back is a dollar amount: "$45.67" beats a bare number; cents are a good sign.
                    const before = txt.slice(Math.max(0, txt.indexOf(raw) - 2), txt.indexOf(raw));
                    if (/[$]\s*$/.test(before)) score += 8;
                    else if (/[$]/.test(txt)) score -= 6;
                    if (/\.\d{2}$/.test(raw)) score += 2;
                } else {
                    // Bigger numbers usually = balance (not "Earn 3x"); also raw with commas wins.
                    if (/,/.test(raw)) score += 4;
                    if (n >= 1000) score += 2;
                    if (n >= 10000) score += 1;
                }

                // Penalties: percentages, dates, phone numbers, "x" multipliers,
                // credit limits, statement balances, payment due.
                if (/%|\d{1,2}\/\d{1,2}|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}x\b/i.test(txt)) score -= 12;
                // Masked account numbers: "(...1234)", "ending in 1234", "•••• 1234".
                if (/\.{3}\s*\d{4}|ending in\s*\d{4}|[•*x]{2,}\s*\d{4}/i.test(txt)) score -= 20;
                if (/\b(zip|account|card|ending|exp|expir|interest|apr|fee|credit limit|available credit|statement balance|minimum|payment due|autopay|installment)\b/i.test(txt + " " + ctx)) score -= 10;
                const labelBefore = ((el.previousElementSibling && (el.previousElementSibling.innerText || el.previousElementSibling.textContent)) || "").toLowerCase();
                if (/\b(current balance|statement balance|balance due|amount due|minimum payment|credit limit|available credit|pending|last statement|payment)\b/.test(labelBefore + " " + lower)) score -= 25;
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
        lastScan = candidates.slice(0, 20);
        // On pages listing several cards, keep to the numbers closest to this card's name.
        // Depth 0 means the number sits in the card's own label ("Sapphire (...9876)"), not a balance.
        const named = candidates.filter((c) => c.cardDepth >= 1 && c.score >= 8);
        const closest = Math.min(...named.map((c) => c.cardDepth));
        const best = (named.length ? named.filter((c) => c.cardDepth === closest) : candidates)[0];
        if (!best || best.score < 8) return null;

        // Build a stable selector for the chosen element.
        // A precise path to the element (id, test id, or tag/class/position chain), so a confirmed
        // spot keeps pointing at this number and not at the first similar element on the page.
        function shortSelector(el) {
            const attr = (node) => {
                if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) return `#${CSS.escape(node.id)}`;
                for (const name of ["data-testid", "data-pt-name", "data-cy"]) {
                    const v = node.getAttribute && node.getAttribute(name);
                    if (v) return `[${name}="${CSS.escape(v)}"]`;
                }
                return null;
            };
            const parts = [];
            let cur = el;
            for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
                const own = attr(cur);
                if (own) { parts.unshift(own); break; }
                let seg = cur.tagName.toLowerCase();
                const cls = (cur.className && typeof cur.className === "string")
                    ? cur.className.trim().split(/\s+/).filter((c) => c && c.length < 40 && !/^\d/.test(c) && !/\d{3,}/.test(c) && !/^fins-/.test(c)).slice(0, 2)
                    : [];
                if (cls.length) seg += "." + cls.map((c) => CSS.escape(c)).join(".");
                const parent = cur.parentElement;
                if (parent) {
                    const same = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
                    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
                }
                parts.unshift(seg);
                if (!parent || parent === document.body || parent === document.documentElement) break;
                cur = parent;
            }
            return parts.join(" > ");
        }

        lastFound = best.el;
        return {
            text: best.raw,
            html: best.el.outerHTML.slice(0, 400),
            selector: shortSelector(best.el),
            via: "heuristic",
            score: best.score,
            candidates: candidates.slice(0, 5).map((c) => ({ text: c.txt, n: c.n, score: c.score })),
        };

    }

    // Watches a single-page portal until the balance settles (or the time runs out).
    function watch(selectorList, regexStr, unitHint, timeoutMs, hints) {
        // Reuse a single watcher per page; cancel the previous one if any.
        try { if (window.__finsWatcherCancel) window.__finsWatcherCancel(); } catch { /* noop */ }


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
                    const v = extract(selectorList, regexStr, unitHint, hints);
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

    // True when the page shows a sign-in or verification form.
    function signInShown() {
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
        } catch {
            return false;
        }

    }

    // The link that leads to the rewards balance on this site, followed or clicked.
    function findRewardsLink(hintWords, avoid) {
        const HINTS = (hintWords || []).map((w) => String(w).toLowerCase()).filter((w) => w.length >= 3);
        const AVOID = new Set(avoid || []);
        const GOOD = [
            [/\b(ultimate rewards|membership rewards|thankyou|rapid rewards|skymiles|mileageplus|aadvantage|bonvoy|honors|trueblue|aeroplan|avios|mileage plan)\b/, 10],
            [/\b(rewards? (summary|balance|center|dashboard|home|activity|account)|my rewards|view (my )?rewards|see rewards|points (summary|balance|activity)|miles (summary|balance|activity)|my (points|miles)|account (summary|overview))\b/, 8],
            [/\brewards?\b/, 6],
            [/\b(points|miles|cash ?back)\b/, 4],
            [/\bredeem\b/, 2],
        ];
        const BAD = /\b(apply|learn more|terms|faq|help|support|sign ?out|log ?out|offers?|deals|shop|transfer partners|refer|earn more|credit score|privacy|careers|español)\b/;

        function visible(el) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return false;
            const cs = getComputedStyle(el);
            return cs.visibility !== "hidden" && cs.display !== "none";
        }
        let best = null;
        for (const el of document.querySelectorAll("a[href], [role='link'], [role='tab'], button, [role='menuitem']")) {
            if (!visible(el)) continue;
            const text = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
            if (!text || text.length > 80) continue;
            let score = 0;
            for (const [rx, points] of GOOD) if (rx.test(text)) { score += points; break; }
            if (HINTS.some((h) => text.includes(h))) score += 6;
            if (BAD.test(text)) score -= 10;
            let href = null;
            if (el.tagName === "A") {
                try {
                    const u = new URL(el.getAttribute("href"), location.href);
                    if (!/^https?:$/.test(u.protocol)) continue;
                    // Stay on the same site (sub-domains allowed: secure.chase.com → chase.com).
                    const site = (h) => h.split(".").slice(-2).join(".");
                    if (site(u.hostname) !== site(location.hostname)) continue;
                    href = u.href;
                    if (/rewards?|points|miles|loyalty/i.test(u.pathname + u.hash)) score += 3;
                } catch { continue; }
                if (AVOID.has(href) || href === location.href) continue;
            }
            if (score > (best?.score || 0)) best = { el, href, score };
        }
        if (!best || best.score < 8) return null;
        if (best.href) return { href: best.href, score: best.score };
        try { best.el.click(); return { clicked: true, score: best.score }; } catch { return null; }

    }

    function findElement(selector) {
        if (!selector) return null;
        try {
            const direct = document.querySelector(selector);
            if (direct) return direct;
        } catch { return null; }
        // Open shadow roots, which document.querySelector does not enter.
        const stack = [document.documentElement];
        while (stack.length) {
            const node = stack.pop();
            for (const child of node.children || []) {
                if (child.shadowRoot) {
                    try { const hit = child.shadowRoot.querySelector(selector); if (hit) return hit; } catch { /* bad selector */ }
                    stack.push(child.shadowRoot);
                }
                stack.push(child);
            }
        }
        return null;
    }

    // Outlines the balance that was found so the user can confirm it.
    function highlight(selector) {
        clearHighlight();
        const el = (lastFound && lastFound.isConnected ? lastFound : null) || findElement(selector);
        if (!el) return false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        const box = document.createElement("div");
        box.id = "fins-highlight";
        const place = () => {
            const r = el.getBoundingClientRect();
            Object.assign(box.style, { position: "fixed", left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px`, border: "3px solid #1d6b4a", borderRadius: "8px", boxShadow: "0 0 0 4px rgba(29,107,74,0.18)", zIndex: "2147483645", pointerEvents: "none" });
        };
        place();
        document.documentElement.appendChild(box);
        box.__finsTimer = setInterval(() => (el.isConnected ? place() : clearHighlight()), 250);
        return true;
    }
    function clearHighlight() {
        const box = document.getElementById("fins-highlight");
        if (box) { clearInterval(box.__finsTimer); box.remove(); }
    }

    // The likeliest balances on the page, for the picker to suggest: [{ el, text, n, label }].
    function suggestions(unitHint, hints, limit = 3) {
        extract(null, null, unitHint, hints);
        const seen = new Set();
        const out = [];
        for (const c of lastScan) {
            if (c.score < 4 || seen.has(c.n) || !c.el.isConnected) continue;
            // Not masked card numbers ("...9876") or whole blocks of text.
            if (/\.{3}\s*\d{4}|ending in|[•*x]{2,}\s*\d{4}/i.test(c.txt) || c.txt.length > 40) continue;
            seen.add(c.n);
            out.push({ el: c.el, text: c.raw, n: c.n, label: labelFor(c.el) });
            if (out.length >= limit) break;
        }
        return out;
    }

    // A short label for a number: the nearest text before it ("Ultimate Rewards", "Cash back").
    function labelFor(el) {
        let node = el;
        for (let d = 0; d < 4 && node; d++) {
            let prev = node.previousElementSibling;
            while (prev) {
                const t = (prev.innerText || prev.textContent || "").replace(/\s+/g, " ").trim();
                if (t && /[a-z]/i.test(t) && t.length <= 40 && !/^[\d\s,.$]+$/.test(t)) return t;
                prev = prev.previousElementSibling;
            }
            node = node.parentElement;
        }
        return "";
    }

    // Resolves once the page has stopped changing for quietMs (or after maxMs).
    function settle(quietMs = 800, maxMs = 6000) {
        return new Promise((resolve) => {
            let timer = setTimeout(done, quietMs);
            const stop = setTimeout(done, maxMs);
            const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
            observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
            function done() { observer.disconnect(); clearTimeout(timer); clearTimeout(stop); resolve(true); }
        });
    }


    // A same-site link or tab whose text has one of the words ("benefits activity", "offers").
    // Words earlier in the list win; between equals an in-page tab beats a link, and a short label
    // beats a long one. The tab already selected and the page already open are skipped, and so are
    // links (by href) and buttons ("text:<label>") in avoid. Followed by href, or clicked when it is
    // a button or tab. Returns { href } / { clicked, text } / null.
    function findLink(words, avoid) {
        const WANT = (words || []).map((w) => String(w).toLowerCase());
        const AVOID = new Set(avoid || []);
        const BAD = /\b(apply|learn more|terms|faq|help|support|sign ?out|log ?out|refer|privacy|careers|español|compare|enroll|disclosures?)\b/;
        const site = (h) => h.split(".").slice(-2).join(".");
        const here = location.href.split("#")[0];
        let best = null;
        for (const el of document.querySelectorAll("a[href], [role='link'], [role='tab'], button, [role='menuitem'], [role='button']")) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") === "page") continue;
            const text = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
            if (!text || text.length > 60 || BAD.test(text)) continue;
            const hit = WANT.findIndex((w) => text.includes(w));
            if (hit < 0) continue;
            let href = null;
            if (el.tagName === "A" && el.getAttribute("href") && !/^(#|javascript:)/i.test(el.getAttribute("href"))) {
                try {
                    const u = new URL(el.getAttribute("href"), location.href);
                    if (!/^https?:$/.test(u.protocol) || site(u.hostname) !== site(location.hostname)) continue;
                    href = u.href;
                } catch { continue; }
                if (AVOID.has(href) || href.split("#")[0] === here) continue;
            } else if (AVOID.has(`text:${text}`)) continue;
            const score = 100 - hit * 5 + (el.getAttribute("role") === "tab" ? 2 : 0) - text.length / 10;
            if (!best || score > best.score) best = { el, href, text, score };
        }
        if (!best) return null;
        if (best.href) return { href: best.href };
        try { best.el.scrollIntoView({ block: "center" }); best.el.click(); return { clicked: true, text: best.text }; } catch { return null; }
    }

    // Open collapsed benefit details ("View details", "Track progress", accordions) so usage is on
    // the page. Only buttons that expand something in place; never links that leave the page.
    async function expandDetails() {
        const WANT = /(view|see|show|track)\s+(details|progress|more|all|usage|benefits)|details|progress|expand|more info/i;
        let opened = 0;
        for (const el of document.querySelectorAll("button[aria-expanded='false'], [role='button'][aria-expanded='false'], summary, details:not([open]) > summary")) {
            if (opened >= 40) break;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            // Not the site's menus, dropdowns or card switcher: only sections that open in place.
            if (el.getAttribute("aria-haspopup") || el.closest("header, nav, [role='navigation'], [role='banner'], [role='menubar']")) continue;
            const t = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.trim();
            if (/^(menu|search|close|cancel|log ?out|sign ?out)$/i.test(t)) continue;
            if (el.tagName !== "SUMMARY" && !WANT.test(t) && t.length > 60) continue;
            try { el.click(); opened += 1; } catch { /* keep going */ }
            await new Promise((res) => setTimeout(res, 120));
        }
        return opened;
    }

    // Card benefits with their usage: [{ title, used, total, remaining, fullyUsed }].
    // Reads tiles such as "Uber Cash · $10 of $10 used", "Digital Entertainment · $0 remaining",
    // "Saks credit · Completed", and progress bars (aria-valuenow / aria-valuemax).
    function readBenefits() {
        const money = (s) => Number(String(s).replace(/[$,\s]/g, ""));
        const OF = /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:of|\/|out of)\s*\$\s?([\d,]+(?:\.\d{2})?)/i;
        const USED = /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:used|earned|redeemed|spent|received|credited|applied)|(?:used|earned|redeemed|spent|received|credited)\s*:?\s*\$\s?([\d,]+(?:\.\d{2})?)/i;
        const LEFT = /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:remaining|left|available|to go)/i;
        const DONE = /\b(fully used|fully earned|earned in full|used in full|completed|complete|all used|maxed out|maximum (reached|earned)|credit (received|applied|issued)|you('ve| have) (used|earned|received) (it|this|the full|your)|no (credit|balance) (remaining|left))\b/i;
        const found = [];
        for (const el of document.querySelectorAll("li, article, section, div, [role='listitem']")) {
            const text = (el.innerText || "").replace(/[  ]/g, " ").trim();
            if (text.length < 8 || text.length > 600) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            let used = null, total = null, remaining = null;
            const of = text.match(OF);
            if (of) { used = money(of[1]); total = money(of[2]); }
            const u = text.match(USED); if (u && used == null) used = money(u[1] || u[2]);
            const l = text.match(LEFT); if (l) remaining = money(l[1]);
            const bar = el.querySelector("[role='progressbar'][aria-valuenow]");
            if (bar && used == null) {
                const now = Number(bar.getAttribute("aria-valuenow")), max = Number(bar.getAttribute("aria-valuemax") || 100);
                if (Number.isFinite(now) && max > 0) { used = now; total = max; }
            }
            const done = DONE.test(text);
            if (used == null && remaining == null && !done) continue;
            // A list of benefits (or the page around them), not one benefit.
            if (el.querySelector("nav, header, h1, [role='navigation']") || el.querySelectorAll("h2, h3, h4, [role='heading']").length > 1 || el.querySelectorAll("[aria-expanded]").length > 1) continue;
            // The benefit's name: a line that isn't a status ("Credit received", "$5 used", "View details").
            const isStatus = (t) => DONE.test(t) || OF.test(t) || USED.test(t) || LEFT.test(t) || /^(view|see|show|hide|track)\b|^(used|remaining|earned|completed?|details|learn more|enrolled?)\b/i.test(t);
            // Amex names its credits by their size ("$200 Uber Cash", "$300 Digital Entertainment
            // Credit"): a line that starts with the amount is a name; the amount is dropped.
            const named = (t) => !/\$\s?\d/.test(t) || /^\$\s?[\d,]+(?:\.\d{2})?\s+[a-z]/i.test(t);
            const line = text.split(/\n+/).map((t) => t.trim()).find((t) => /[a-z]{3}/i.test(t) && t.length <= 80 && named(t) && !isStatus(t));
            const title = line && line.replace(/^\$\s?[\d,]+(?:\.\d{2})?\s+/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
            if (!title || !/[a-z]{3}/i.test(title)) continue;
            const fullyUsed = done || (total > 0 && used >= total) || (remaining === 0 && (used > 0 || total > 0 || /\$\s?0(\.00)?\s*(remaining|left)/i.test(text)));
            found.push({ el, title, used, total, remaining, fullyUsed });
        }
        // Keep the smallest block for each benefit (a tile, not the list that holds it).
        return found
            .filter((f) => !found.some((g) => g !== f && f.el.contains(g.el) && g.title === f.title))
            .filter((f, i, all) => all.findIndex((g) => g.title === f.title) === i)
            .slice(0, 60)
            .map(({ title, used, total, remaining, fullyUsed }) => ({ title: title.replace(/[®™]/g, "").trim(), used, total, remaining, fullyUsed }));
    }

    // Rewards activity lines: [{ date, description, amount }], amount negative for redemptions.
    // A line has a date and a signed or labelled amount ("+1,250 pts", "-5,000", "$2.50").
    function readActivity(unitHint) {
        const DATE = /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
        const AMOUNT = unitHint === "cashback"
            ? /([+\-−]?)\s*\$\s?([\d,]+\.\d{2})/g
            : /([+\-−]?)\s*([\d]{1,3}(?:,\d{3})+|\d+)\s*(pts|points|miles)?\b/gi;
        const rows = [];
        for (const el of document.querySelectorAll("tr, li, [role='row'], [role='listitem']")) {
            const text = (el.innerText || "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
            if (text.length < 8 || text.length > 220) continue;
            const date = text.match(DATE);
            if (!date) continue;
            const rest = text.replace(date[0], " ");
            let pick = null;
            for (const m of rest.matchAll(AMOUNT)) {
                const value = Number(m[2].replace(/,/g, ""));
                if (!Number.isFinite(value) || value === 0) continue;
                const labelled = Boolean(m[1]) || Boolean(m[3]) || unitHint === "cashback";
                if (!labelled) continue;
                pick = { sign: m[1] === "-" || m[1] === "−" ? -1 : 1, value, raw: m[0] };
            }
            if (!pick) continue;
            const redeem = /\b(redeem|redeemed|redemption|transfer(red)? to|used for|pay with points|reversal|returned)\b/i.test(rest);
            const description = rest.replace(pick.raw, " ").replace(/(^|\s)[·•|–—:\-]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
            if (!/[a-z]{3}/i.test(description)) continue;
            rows.push({ date: date[0], description, amount: pick.value * (pick.sign < 0 || redeem ? -1 : 1) });
            if (rows.length >= 60) break;
        }
        return rows.length >= 2 ? rows : []; // a single matching line is more likely noise than a list
    }


    // Select a card in the site's own card/account switcher (portals that hold several cards, like
    // Amex). words: the card's distinctive name words; others: the other cards' words (to recognise
    // the switcher button, which shows the current card). Returns:
    //   { ok: true, already } | { ok: true, clicked } | { ok: false, reason: "no-switcher" | "no-option" }
    async function switchAccount(words, others) {
        const want = (words || []).map((w) => String(w).toLowerCase()).filter(Boolean);
        if (!want.length) return { ok: false, reason: "no-option" };
        const otherSets = (others || []).map((ws) => ws.map((w) => String(w).toLowerCase())).filter((ws) => ws.length);
        const OFFER = /(\$\s?\d+(?:[.,]\d{1,2})?\s*(?:cash\s*)?back|\d+(?:\.\d+)?\s*%\s*(?:cash\s*)?back|earn\s+[\d,]+)/i;
        const text = (el) => `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
        const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden"; };
        const names = (t, ws) => ws.every((w) => t.includes(w));
        const looksLikeAccount = (el, t) => /\.{3}\s*\d{4}|[•*x]{2,}\s*\d{4}|ending in|\bcard\b|account/i.test(t) || /option|menuitem|tab|radio/.test(el.getAttribute("role") || "") || el.closest("[role='listbox'], [role='menu'], [role='tablist'], [role='radiogroup']");
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));

        // Already selected: the switcher (or a selected option) shows this card.
        const alreadySelected = () => {
            const seen = detectCard([{ id: "this", words: want }, ...otherSets.map((ws, i) => ({ id: `other${i}`, words: ws }))]);
            return Boolean(seen && seen.strong && seen.id === "this");
        };
        const anySwitcher = () => [...document.querySelectorAll("[aria-haspopup], [role='listbox'], [role='tablist'], [role='option']")].some(shown)
            || [...document.querySelectorAll("button, a")].some((el) => shown(el) && otherSets.some((ws) => names(text(el), ws)));
        // Bank pages draw late: give the switcher a few seconds to appear.
        for (let i = 0; i < 10 && !alreadySelected() && !anySwitcher(); i++) await pause(500);
        if (alreadySelected()) return { ok: true, already: true };
        const option = () => [...document.querySelectorAll("[role='option'], [role='menuitem'], [role='tab'], [role='radio'], li, button, a")]
            .filter((el) => shown(el) && !el.closest("#fins-launcher-root, #fins-status-root, #fins-prompt-root"))
            .map((el) => ({ el, t: text(el) }))
            .filter(({ el, t }) => t.length <= 90 && names(t, want) && !OFFER.test(t) && looksLikeAccount(el, t))
            .sort((a, b) => a.t.length - b.t.length)[0]?.el || null;
        let target = option();
        let opener = null;
        if (!target) {
            // Open the switcher: a popup button naming another card, or one labelled as a card/account picker.
            opener = [...document.querySelectorAll("[aria-haspopup], [aria-expanded='false'], button")]
                .filter((el) => shown(el))
                .find((el) => { const t = text(el); return t.length <= 90 && !OFFER.test(t) && (otherSets.some((ws) => names(t, ws)) || /switch (card|account)|select (a )?(card|account)|change (card|account)|my accounts|all accounts/.test(t)); }) || null;
            if (opener) {
                opener.click();
                await pause(700);
                target = option();
            }
        }
        if (!target) return { ok: false, reason: opener ? "no-option" : "no-switcher" };
        // Click just after answering: many sites reload the page when the card changes.
        setTimeout(() => target.click(), 50);
        return { ok: true, clicked: true };
    }


    // Which of the user's cards the page is showing right now: the name in the card switcher, the
    // top bar, a selected tab or a heading ("Platinum Card® •••• 1004"). cards: [{ id, words }]
    // (each card's distinctive name words). Returns { id, score, text } or null when no card is
    // named, or two cards are named equally (a page listing several cards).
    function detectCard(cards) {
        const list = (cards || []).map((c) => ({ id: c.id, words: (c.words || []).map((w) => String(w).toLowerCase()).filter(Boolean) })).filter((c) => c.words.length);
        if (!list.length) return null;
        const OFFER = /(\$\s?\d+(?:[.,]\d{1,2})?\s*(?:cash\s*)?back|\d+(?:\.\d+)?\s*%\s*(?:cash\s*)?back|earn\s+[\d,]+)/i;
        const ours = "#fins-launcher-root, #fins-status-root, #fins-prompt-root, #fins-picker-host";
        const seen = new Set();
        const scores = new Map();
        const consider = (el, weight) => {
            if (!el || seen.has(el) || el.closest(ours)) return;
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return;
            const t = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
            if (!t || t.length > 120 || OFFER.test(t)) return;
            const top = r.top + scrollY < 220 ? 3 : 0; // the bar at the top of the page
            for (const c of list) {
                if (!c.words.every((w) => t.includes(w))) continue;
                const s = weight + top;
                const best = scores.get(c.id);
                if (!best || s > best.score) scores.set(c.id, { id: c.id, score: s, text: t.slice(0, 80) });
            }
        };
        // Strongest signals first: the switcher button and selected items, then the page's top bar and headings.
        document.querySelectorAll("[aria-haspopup], [aria-selected='true'], [aria-current='true'], [aria-current='page'], [aria-checked='true']").forEach((el) => consider(el, 8));
        document.querySelectorAll("header *, [role='banner'] *, nav *").forEach((el) => { if (el.children.length <= 3) consider(el, 5); });
        document.querySelectorAll("h1, h2, [role='heading']").forEach((el) => consider(el, 4));
        // Anything else near the top of the page that names a card on its own.
        for (const el of document.body ? document.body.querySelectorAll("*") : []) {
            if (el.children.length > 3) continue;
            const r = el.getBoundingClientRect();
            if (r.top + scrollY < 220) consider(el, 1);
        }
        const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
        if (!ranked.length) return null;
        if (ranked[1] && ranked[1].score === ranked[0].score) return null; // two cards named just as strongly
        // Strong: named by the switcher, a selected item or the top bar, not just somewhere on the page.
        return { ...ranked[0], strong: ranked[0].score >= 7 };
    }

    // Does the balance found last sit in a block that names this card ("Blue Cash Everyday (...5555)")?
    function foundNearCard(words) {
        const want = (words || []).map((w) => String(w).toLowerCase()).filter(Boolean);
        let node = lastFound && lastFound.isConnected ? lastFound : null;
        if (!want.length || !node) return false;
        for (let d = 0; d < 6 && node; d++) {
            if (node === document.body || node === document.documentElement) return false; // not the whole page (or our own notes)
            const t = (node.innerText || node.textContent || "").toLowerCase();
            if (t.length > 700) return false;
            if (want.every((w) => t.includes(w))) return true;
            node = node.parentElement;
        }
        return false;
    }

    // Every card the site lists for this login: the card switcher's options, account tiles, the
    // card in the top bar. Each is a short text with a masked number ("The Platinum Card® •••• 1004").
    // Reads the switcher's options even while hidden; opens it (and closes it again) only when the
    // site draws them on open. Returns [{ text }]; the worker cleans and matches them.
    async function listSiteCards() {
        const MASK = /(?:\.{2,}|[•*·∙●]+|(?<![a-z])x{1,4}|ending(?: in)?)\s*\d{4}\b/i;
        const OFFER = /(\$\s?\d|%|\bearn\b|\bspend\b|\bpay\b|\bdue\b|\bbalance\b|statement|payment|transaction)/i;
        const ours = "#fins-launcher-root, #fins-status-root, #fins-prompt-root, #fins-picker-host, #fins-board-root";
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
        const collect = () => {
            const out = new Map();
            const add = (el) => {
                if (!el || el.closest(ours)) return;
                const t = textOf(el);
                if (!t || t.length > 90 || !MASK.test(t) || OFFER.test(t)) return;
                const n = (t.match(/(\d{4})\b(?!.*\d{4}\b)/) || [])[1];
                if (n && (!out.has(n) || t.length < out.get(n).length)) out.set(n, t);
            };
            document.querySelectorAll("[role='option'], [role='menuitem'], [role='menuitemradio'], [role='tab'], [role='radio'], [aria-haspopup], li, button, a, h1, h2, h3").forEach(add);
            // Short leaf-ish blocks too (account tiles), but not whole sections.
            for (const el of document.body ? document.body.querySelectorAll("div, span, p") : []) if (el.children.length <= 3) add(el);
            return out;
        };
        let found = collect();
        // One card shown and a switcher that lists the rest only when opened: open it, read, close it.
        const opener = [...document.querySelectorAll("[aria-haspopup][aria-expanded='false'], [aria-haspopup]:not([aria-expanded])")]
            .find((el) => !el.closest(ours) && MASK.test(textOf(el)) && el.getBoundingClientRect().width > 2);
        if (opener && found.size < 2) {
            opener.click();
            await pause(700);
            found = new Map([...found, ...collect()]);
            if (opener.getAttribute("aria-expanded") === "true") opener.click();
            else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }
        return [...found.values()].map((text) => ({ text }));
    }

    window.__finsReader = { extract, watch, signInShown, findRewardsLink, findLink, readBenefits, expandDetails, readActivity, highlight, clearHighlight, suggestions, settle, switchAccount, detectCard, foundNearCard, listSiteCards };
})();
