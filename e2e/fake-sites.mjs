// Fake Finstracker API and fake bank on http://localhost:3000, a host the extension may access.
// The bank: sign-in, a dashboard without balances, a rewards page (two points cards, a cash back
// card, activity lines), an offers page with "Add to Card" buttons, a benefits page with usage.
// Strict Content-Security-Policy everywhere; Trusted Types on the rewards page.
import http from "node:http";

const endOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10) + "T23:59:59.999Z"; };

export function startServer({ port = 3000 } = {}) {
    const state = {
        cards: {
            c1: { id: "c1", displayName: "Sapphire Preferred", issuer: "Mock Bank", rewardType: "points", currentPoints: 1000, currentCashBack: 0, pointValueCents: 1.25, multipliers: { dining: 3 }, program: "Chase Ultimate Rewards" },
            c2: { id: "c2", displayName: "Blue Cash Everyday", issuer: "Mock Bank", rewardType: "cashback", currentPoints: 0, currentCashBack: 0, pointValueCents: 1, multipliers: { groceries: 3 }, program: "Cash back" },
            c3: { id: "c3", displayName: "Amex Gold Card", issuer: "Mock Bank", rewardType: "points", currentPoints: 0, currentCashBack: 0, pointValueCents: 1.6, multipliers: { dining: 4 }, program: "Membership Rewards" },
            c5: { id: "c5", displayName: "Amex Green Card", issuer: "Mock Bank", rewardType: "points", currentPoints: 0, currentCashBack: 0, pointValueCents: 1.6, multipliers: { travel: 3 }, program: "Membership Rewards" },
            c4: { id: "c4", displayName: "Amex Platinum Card", issuer: "Mock Bank", rewardType: "points", currentPoints: 0, currentCashBack: 0, pointValueCents: 1.6, multipliers: { travel: 5 }, program: "Membership Rewards" },
        },
        transactions: [],
        perks: [
            { id: "p-uber", cardId: "c1", title: "Uber Cash · Nov", valueCents: 1000, deadline: endOfMonth(), used: false },
            { id: "p-de", cardId: "c1", title: "Digital Entertainment Credit · Nov", valueCents: 2000, deadline: endOfMonth(), used: false },
            { id: "p-dining", cardId: "c3", title: "Dining Credit · Nov", valueCents: 1000, deadline: endOfMonth(), used: false },
            { id: "p-saks", cardId: "c1", title: "Saks Fifth Avenue Credit · H2", valueCents: 5000, deadline: endOfMonth(), used: false },
        ],
        offers: [],
        newCard: false, // the switcher also lists a card the user hasn't added to Finstracker
        urlKeyed: false, // like Amex: the page address (?account_key=) picks the card, and every link carries it
        log: [], // [{ t, cardId, kind }] when balances and offers were saved
        created: [],
        get points() { return this.cards.c1.currentPoints; },
    };
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
    const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
    const send = (res, code, type, body, headers = {}) => { res.writeHead(code, { "content-type": type, ...headers }); res.end(body); };
    const json = (res, data, code = 200) => send(res, code, "application/json", JSON.stringify({ status: code, message: code < 400 ? "OK" : "Error", data }));
    const readBody = async (req) => { let b = ""; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);
        const p = url.pathname;
        if (p === "/api/health") return json(res, { up: true });
        if (p.startsWith("/api/")) {
            if (req.headers.authorization !== "Bearer test-token") return json(res, null, 401);
            const [, , group, id, action] = p.split("/");
            if (group === "cards" && !id && req.method === "POST") {
                const b = await readBody(req);
                if (!b.displayName || !b.issuer || !["points", "cashback"].includes(b.rewardType)) return json(res, { fields: { displayName: "required" } }, 400);
                if (b.cardKey && !/^[a-z0-9-]+$/.test(b.cardKey)) return json(res, { fields: { cardKey: "Unknown card key" } }, 400);
                const card = { id: `n${state.created.length + 1}`, displayName: b.displayName, issuer: b.issuer, rewardType: b.rewardType, cardKey: b.cardKey || null, currentPoints: 0, currentCashBack: 0, pointValueCents: 1, multipliers: {}, program: b.rewardType === "cashback" ? "Cash back" : `${b.issuer} points` };
                state.cards[card.id] = card;
                state.created.push(b);
                return json(res, card, 201);
            }
            if (group === "cards" && !id) return json(res, Object.values(state.cards));
            if (group === "cards" && id && req.method === "GET") return state.cards[id] ? json(res, state.cards[id]) : json(res, null, 404);
            if (group === "cards" && id && req.method === "PUT") {
                const b = await readBody(req);
                if (b.rewardType && state.transactions.some((t) => t.cardId === id)) return json(res, { fields: { rewardType: "Can't change the reward type of a card with transactions" } }, 400);
                Object.assign(state.cards[id], b);
                return json(res, state.cards[id]);
            }
            if (group === "transactions" && req.method === "POST") {
                const t = await readBody(req);
                const card = state.cards[t.cardId];
                if (t.unit && t.unit !== card.rewardType) return json(res, null, 400);
                const sign = t.type === "earn" ? 1 : -1;
                if (card.rewardType === "cashback") card.currentCashBack = Math.round((card.currentCashBack + sign * t.amount) * 100) / 100;
                else card.currentPoints += sign * t.amount;
                state.transactions.push(t);
                state.log.push({ t: Date.now(), cardId: t.cardId, kind: "balance" });
                return json(res, { transaction: t }, 201);
            }
            if (group === "perks" && !id && req.method === "GET") return json(res, url.searchParams.get("status") === "available" ? state.perks.filter((x) => !x.used) : state.perks);
            if (group === "perks" && id && req.method === "PUT") {
                const perk = state.perks.find((x) => x.id === id);
                Object.assign(perk, { used: Boolean((await readBody(req)).used) });
                return json(res, perk);
            }
            if (group === "offers" && id === "bulk") {
                const b = await readBody(req);
                // An upsert, like the dashboard: the same offer on the same card is updated, never doubled.
                let created = 0;
                for (const o of b.offers) {
                    const i = state.offers.findIndex((x) => x.cardId === b.cardId && x.merchant === o.merchant);
                    if (i >= 0) state.offers[i] = { ...state.offers[i], ...o, activated: state.offers[i].activated || o.activated, cardId: b.cardId };
                    else { state.offers.push({ ...o, cardId: b.cardId }); created++; }
                }
                state.log.push({ t: Date.now(), cardId: b.cardId, kind: "offers" });
                return json(res, { received: b.offers.length, created, updated: b.offers.length - created }, 201);
            }
            if (group === "offers" && !id && req.method === "DELETE") {
                const before = state.offers.length;
                state.offers = state.offers.filter((o) => o.cardId !== url.searchParams.get("cardId"));
                return json(res, { deletedCount: before - state.offers.length });
            }
            if (group === "perks" && !id && req.method === "DELETE") {
                const before = state.perks.length;
                state.perks = state.perks.filter((x) => x.cardId !== url.searchParams.get("cardId"));
                return json(res, { deletedCount: before - state.perks.length });
            }
            if (group === "cards" && id && req.method === "DELETE") {
                if (!state.cards[id]) return json(res, null, 404);
                delete state.cards[id];
                return json(res, null);
            }
            if (group === "offers") return json(res, []);
            return json(res, null, 404);
        }

        const h = { "content-security-policy": csp, "cache-control": "no-store" };
        if (p === "/bank/app.js") return send(res, 200, "text/javascript", `
            // Single-page app: content arrives late, some links navigate in-app (like Amex), and the
            // DOM is built without innerHTML so it also runs under Trusted Types.
            const el = (tag, text, style) => { const n = document.createElement(tag); if (text) n.textContent = text; if (style) n.style.cssText = style; return n; };
            const tile = (lines) => { const d = el("div"); d.className = "tile"; for (const [t, big] of lines) d.append(el("div", t, big ? "font-size:28px" : "")); return d; };
            const more = location.search.includes("more");
            const ACCOUNTS = { c1: ["Sapphire Preferred (...9876)", "OQX90"], c3: ["Gold Card (...3001)", "GLD31"], c4: ["The Platinum Card® (...1004)", "PLT04"]${state.newCard ? ', c9: ["Delta SkyMiles® Gold Card (...3004)", "DLT04"], c8: ["Hilton Honors Aspire Card (...2008)", "HLT08"]' : ""} };
            const KEYED = ${state.urlKeyed ? "true" : "false"};
            const byKey = Object.fromEntries(Object.entries(ACCOUNTS).map(([id, [, key]]) => [key, id]));
            const acct = (KEYED && byKey[new URLSearchParams(location.search).get("account_key")]) || (document.cookie.match(/acct=(c[0-9])/) || [])[1] || "c1";
            const keyed = (href) => KEYED ? href + (href.includes("?") ? "&" : "?") + "account_key=" + ACCOUNTS[acct][1] : href;
            function switcher() {
                const h = el("header"); h.id = "acct";
                const b = el("button", ACCOUNTS[acct][0] + " ▾"); b.setAttribute("aria-haspopup", "listbox"); b.setAttribute("aria-expanded", "false");
                const list = el("ul"); list.setAttribute("role", "listbox"); list.hidden = true;
                for (const [id, [name, key]] of Object.entries(ACCOUNTS)) {
                    const li = el("li", name); li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(id === acct));
                    li.addEventListener("click", () => {
                        document.cookie = "acct=" + id + "; path=/";
                        if (KEYED) { location.href = location.pathname + "?account_key=" + key; return; }
                        history.replaceState({}, "", location.pathname + "?opaqueAccountId=" + key); location.reload();
                    });
                    list.append(li);
                }
                b.addEventListener("click", () => { list.hidden = !list.hidden; b.setAttribute("aria-expanded", String(!list.hidden)); });
                h.append(b, list);
                return h;
            }
            function nav() {
                const n = el("nav");
                for (const [href, text, spa] of [["/bank/help", "Help"], ["/bank/offers", "Offers"], ["/bank/benefits", "Benefits"], ["/bank/rewards?opaqueAccountId=OQX90", "Ultimate Rewards"], ["/bank/rewards?opaqueAccountId=OQX90", "Rewards (in-app)", true]]) {
                    const a = el("a", text); a.href = keyed(href);
                    if (spa) { a.id = "spa-link"; a.addEventListener("click", (e) => { e.preventDefault(); history.pushState({}, "", href); setTimeout(draw, 800); }); }
                    n.append(a, " ");
                }
                return n;
            }
            function amexNav() {
                const n = el("nav");
                for (const [href, text] of [["/bank/amex-home", "Home"], ["/bank/help", "Statements & Activity"], ["/bank/amex-hub", "Rewards & Benefits"]]) { const a = el("a", text); a.href = href; n.append(a, " "); }
                const menu = el("button", "Earn and Redeem"); menu.setAttribute("aria-expanded", "false");
                menu.addEventListener("click", () => { document.body.dataset.menu = "opened"; });
                n.append(menu);
                return n;
            }
            function amexHub(root) {
                const activity = location.pathname === "/bank/amex-hub/activity";
                const tabs = el("div"); tabs.setAttribute("role", "tablist");
                for (const [text, path] of [["Browse Benefits", "/bank/amex-hub"], ["View Benefits Activity", "/bank/amex-hub/activity"]]) {
                    const t = el("button", text); t.setAttribute("role", "tab"); t.setAttribute("aria-selected", String(location.pathname === path));
                    t.addEventListener("click", () => { history.pushState({}, "", path); setTimeout(draw, 600); });
                    tabs.append(t);
                }
                root.append(el("h2", "Explore Benefits"), tabs);
                if (!activity) {
                    // Browse: what each benefit is, no usage.
                    for (const [name, text] of [["$200 Uber Cash", "Get up to $15 in Uber Cash each month when you add your card to your Uber account."], ["$300 Digital Entertainment Credit", "Get up to $25 back each month on eligible subscriptions. Enrollment required."]]) {
                        const t = el("section"); t.className = "benefit"; t.append(el("h3", name), el("p", text), el("button", "Learn More")); root.append(t);
                    }
                    return;
                }
                root.append(el("h2", "Track Progress"), el("p", "Trackers may not reflect recent activity."));
                for (const lines of [
                    ["$200 Uber Cash", "Earned this Year $150.00", "$15 Earned Nov", "$0 To Go", "Get up to $15 in Uber Cash each month."],
                    ["$300 Digital Entertainment Credit", "Earned this Year $100.00", "$5 Earned Nov", "$20 To Go", "Receive up to $25 back each month."],
                    ["$209 CLEAR Plus Credit (formerly the $189 CLEAR Credit)", "$209 Earned", "$0 To Go", "Get up to $209 back per calendar year on CLEAR Plus."],
                    ["Centurion Lounge Guest Access", "$1,000 spent", "$74,000 To Go", "Spend $75,000 in eligible purchases to unlock guest access."],
                ]) {
                    const t = el("div"); t.className = "tracker"; t.append(el("h3", lines[0]));
                    for (const l of lines.slice(1)) t.append(el("p", l));
                    root.append(t);
                }
            }
            var draw = function () {
                const root = document.getElementById("root");
                if (location.pathname.startsWith("/bank/amex-home") || location.pathname.startsWith("/bank/amex-hub")) {
                    root.replaceChildren(amexNav());
                    if (location.pathname === "/bank/amex-home") root.append(tile([["Platinum Card® (...1004)"], ["Membership Rewards® Points"], ["150,000", true]]), el("p", "Statement balance $1,240.18"));
                    else amexHub(root);
                    return;
                }
                root.replaceChildren(nav());
                if (location.pathname !== "/bank/dashboard") root.append(switcher());
                if (location.pathname === "/bank/dashboard") {
                    root.append(tile([["Sapphire Preferred (...9876)"], ["Current balance"], ["$1,111.00", true]]));
                    if (location.search.includes("promo")) root.append(tile([["Welcome offer"], ["2,000", true], ["bonus points"]]));
                } else if (location.pathname === "/bank/rewards") {
                    root.append(
                        tile([["Freedom Unlimited (...1234)"], ["Cash back rewards"], ["12,345", true], ["points"]]),
                        acct === "c3" ? tile([["Gold Card (...3001)"], ["Membership Rewards"], ["45,000", true], ["points"]])
                            : acct === "c4" ? tile([["The Platinum Card® (...1004)"], ["Membership Rewards"], ["150,000", true], ["points"]])
                            : acct === "c9" ? tile([["Delta SkyMiles® Gold Card (...3004)"], ["SkyMiles"], ["62,000", true], ["miles"]])
                            : acct === "c8" ? tile([["Hilton Honors Aspire Card (...2008)"], ["Hilton Honors"], ["250,000", true], ["points"]])
                            : tile([["Sapphire Preferred (...9876)"], ["Ultimate Rewards"], [more ? "99,265" : "98,765", true], ["points"]]),
                        tile([["Blue Cash Everyday (...5555)"], ["Statement balance"], ["$642.10"], ["Reward Dollars"], ["$123.45", true]]),
                    );
                    const list = el("ul"); list.id = "activity";
                    const rows = [["Nov 3", "Uber Eats", "+1,200 pts"], ["Nov 1", "Grocery bonus", "+300 pts"], ["Oct 28", "Transfer to Delta", "-5,000 pts"]];
                    if (more) rows.unshift(["Nov 8", "Dining", "+500 pts"]);
                    for (const r of rows) list.append(el("li", r.join("  ·  ")));
                    root.append(el("h3", "Points activity"), list);
                } else if (location.pathname === "/bank/offers") {
                    const decoy = el("button", "Add card"); decoy.addEventListener("click", () => { document.body.dataset.decoy = "clicked"; });
                    root.append(decoy);
                    // Like Amex: the list arrives late (so one card's offers are still running while
                    // the next card is selected).
                    if (KEYED && !window.__offersReady) { root.append(el("p", "Loading offers…")); setTimeout(() => { window.__offersReady = true; draw(); }, 5000); return; }
                    const offers = acct === "c3" ? [["Saks", "Spend $250, get $50 back", false], ["Hilton", "Earn 5,000 points", false]]
                        : acct === "c9" ? [["Delta Stays", "Spend $200 or more, earn $50", false]]
                        : acct === "c8" ? [["Hilton Resorts", "Earn 10,000 points", false]]
                        : acct === "c4" ? [["Resy", "Spend $100, get $20 back", false]]
                        : [["Best Buy", "Spend $100, get $15 back", false], ["Chipotle", "5% back", true], ["Delta", "Earn 2,000 points", false]];
                    for (const [merchant, badge, added] of offers) {
                        const t = tile([[merchant], [badge], ["Expires Dec 31, 2026"]]);
                        const b = el("button", added ? "Added" : "Add to Card");
                        b.addEventListener("click", () => { b.textContent = "Added"; });
                        t.append(b); root.append(t);
                    }
                } else if (location.pathname === "/bank/amex-offers") {
                    // Amex-style offers: many formats, the list redraws after every click, more behind
                    // "Load more", and one offer whose first click doesn't take.
                    const decoy = el("button", "Add card"); decoy.addEventListener("click", () => { document.body.dataset.decoy = "clicked"; });
                    root.append(decoy);
                    const all = [["Best Buy", "Spend $100, get $15 back"], ["Uber Eats", "Earn 1,000 Membership Rewards® points"], ["Hilton", "Earn +3X points"], ["Dell", "$10 statement credit"], ["Audible", "Get $20 back"],
                        ["Saks", "10% back"], ["Hotels.com", "Earn 2,500 Membership Rewards points"], ["Lyft", "Spend $25, get $5 back"],
                        ["Duolingo", "Spend $75 or more, earn $30"], ["Glasses.com", "Earn +2 Membership Rewards® points per eligible dollar spent, up to 4,000 pts"]];
                    const state = window.__offers || (window.__offers = { shown: 5, added: new Set(), flaky: true });
                    const list = el("div"); list.id = "offer-list";
                    const drawList = () => {
                        list.replaceChildren();
                        for (const [merchant, badge] of all.slice(0, state.shown)) {
                            const t = tile([[merchant], [badge], ["Expires Dec 31, 2026"]]);
                            // Amex's newer tiles: an icon button with only a title.
                            const icon = /Duolingo|Glasses/.test(merchant) && !state.added.has(merchant);
                            const b = el("button", state.added.has(merchant) ? "Added to Card" : icon ? "" : "Add to Card");
                            if (icon) { b.title = "add to list card"; b.append(el("span", "+")); b.firstChild.setAttribute("aria-hidden", "true"); b.style.cssText = "width:28px;height:28px"; }
                            b.addEventListener("click", () => {
                                if (merchant === "Uber Eats" && state.flaky) { state.flaky = false; return; } // first click lost
                                setTimeout(() => { state.added.add(merchant); drawList(); }, 300); // the whole list redraws
                            });
                            t.append(b); list.append(t);
                        }
                    };
                    drawList();
                    root.append(list);
                    if (state.shown < all.length) {
                        const more = el("button", "Load more");
                        more.addEventListener("click", () => { state.shown = all.length; more.remove(); drawList(); });
                        root.append(more);
                    }
                    window.__addedCount = () => state.added.size;
                } else if (location.pathname === "/bank/amex-eligible" || location.pathname === "/bank/amex-enrolled") {
                    // Like Amex: an offer leaves this list once added (the list redraws), and moves to
                    // "Added to Card", a page of its own that also has the offers added before.
                    const added = new Set(JSON.parse(sessionStorage.getItem("added") || "[]"));
                    const all = [["Best Buy", "Spend $100, get $15 back"], ["Duolingo", "Spend $75 or more, earn $30"], ["Glasses.com", "Earn +2 Membership Rewards® points per eligible dollar spent, up to 4,000 pts"],
                        ["Dell", "$10 statement credit"], ["Audible", "Spend $20 or more, earn $5"], ["Lyft", "Spend $25, get $5 back"]];
                    const before = [["Saks", "Spend $50 or more, earn $10"], ["Uber Eats", "Earn 1,000 Membership Rewards® points"], ["Walmart", "Spend $35 or more, earn $7"]];
                    const link = el("a", "Added to Card (" + (before.length + added.size) + ")"); link.href = "/bank/amex-enrolled";
                    root.append(link);
                    const list = el("div"); list.id = "offer-list"; root.append(list);
                    const drawList = () => {
                        list.replaceChildren();
                        const rows = location.pathname === "/bank/amex-enrolled" ? [...before, ...all.filter(([m]) => added.has(m))] : all.filter(([m]) => !added.has(m));
                        for (const [merchant, badge] of rows) {
                            const t = tile([[merchant], [badge], ["Expires 12/31/26"]]);
                            if (location.pathname === "/bank/amex-eligible") {
                                const b = el("button", ""); b.title = "add to list card"; b.append(el("span", "+")); b.style.cssText = "width:28px;height:28px";
                                b.addEventListener("click", () => { added.add(merchant); sessionStorage.setItem("added", JSON.stringify([...added])); setTimeout(drawList, 250); });
                                t.append(b);
                            }
                            list.append(t);
                        }
                    };
                    drawList();
                } else if (location.pathname === "/bank/amex-benefits") {
                    // Amex-style benefits: usage hidden in collapsed "View details" sections.
                    for (const [name, detail] of [["Uber Cash", "Earned $15.00 of $15.00"], ["Digital Entertainment Credit", "$5.00 used · $15.00 remaining"], ["Saks Fifth Avenue Credit", "Credit received"], ["Walmart+ Credit", "$0.00 remaining"]]) {
                        const t = el("section"); t.className = "benefit";
                        const head = el("h3", name);
                        const btn = el("button", "View details"); btn.setAttribute("aria-expanded", "false");
                        const panel = el("div", detail); panel.hidden = true;
                        btn.addEventListener("click", () => { panel.hidden = !panel.hidden; btn.setAttribute("aria-expanded", String(!panel.hidden)); });
                        t.append(head, btn, panel); root.append(t);
                    }
                } else if (location.pathname === "/bank/benefits") {
                    if (acct === "c3") root.append(tile([["Dining Credit"], ["$10 of $10 used"]]));
                    else root.append(tile([["Uber Cash"], ["$10 of $10 used"]]), tile([["Digital Entertainment Credit"], ["$5 of $20 used"]]));
                }
            };
            // Every page ends with a footer full of numbers that are not balances, plus a stray copyright line.
            const drawn = draw;
            draw = function () {
                drawn();
                const root = document.getElementById("root");
                if (location.pathname === "/bank/no-balance") root.append(el("h2", "Membership Rewards"), el("p", "Your points summary is updating."));
                root.append(el("div", "© 2026 Mock Bank, N.A."));
                const f = el("footer");
                f.append(el("p", "© 2026 Mock Bank. All rights reserved."), el("a", "Membership Rewards terms"), el("p", "Questions? Call 1-800-528-4800"), el("p", "Member since 2015"), el("p", "Rewards updated Nov 8, 2026"));
                root.append(f);
            };
            setTimeout(draw, 1200);`, h);
        if (p === "/bank/login" && req.method === "POST") { res.writeHead(302, { location: "/bank/dashboard", "set-cookie": "bank=1; Path=/" }); return res.end(); }
        const signedIn = /(^|;\s*)bank=1/.test(req.headers.cookie || "");
        const pages = ["/bank/dashboard", "/bank/rewards", "/bank/offers", "/bank/benefits", "/bank/amex-offers", "/bank/amex-benefits", "/bank/no-balance", "/bank/amex-home", "/bank/amex-hub", "/bank/amex-hub/activity", "/bank/amex-eligible", "/bank/amex-enrolled"];
        if (pages.includes(p) && !signedIn) { res.writeHead(302, { location: "/bank/login" }); return res.end(); }
        if (p === "/bank/login") return send(res, 200, "text/html", page("Sign in", `<form method="post" action="/bank/login"><input name="user" autocomplete="username"><input type="password" name="pw"><button>Sign in</button></form>`), h);
        if (p === "/bank/rewards") h["content-security-policy"] = `${csp}; require-trusted-types-for 'script'`;
        if (pages.includes(p)) return send(res, 200, "text/html", page("Bank", `<div id="root">Loading…</div><script src="/bank/app.js"></script>`), h);
        return send(res, 404, "text/plain", "not found");
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}
