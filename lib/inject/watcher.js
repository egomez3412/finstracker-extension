// Runs inside issuer pages (see extractor.js). Watches a single-page portal until the balance
// settles, so we do not read the page before its data has loaded.

export function pageWatcher(extractorSrc, selectorList, regexStr, unitHint, timeoutMs) {
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

/** True when the page shows a sign-in or verification form. */
export function authFormProbe() {
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
