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
            c3: { id: "c3", displayName: "Gold Card", issuer: "Mock Bank", rewardType: "points", currentPoints: 0, currentCashBack: 0, pointValueCents: 1.6, multipliers: { dining: 4 }, program: "Membership Rewards" },
        },
        transactions: [],
        perks: [
            { id: "p-uber", cardId: "c1", title: "Uber Cash · Nov", valueCents: 1000, deadline: endOfMonth(), used: false },
            { id: "p-de", cardId: "c1", title: "Digital Entertainment Credit · Nov", valueCents: 2000, deadline: endOfMonth(), used: false },
            { id: "p-dining", cardId: "c3", title: "Dining Credit · Nov", valueCents: 1000, deadline: endOfMonth(), used: false },
        ],
        offers: [],
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
                return json(res, { transaction: t }, 201);
            }
            if (group === "perks" && !id) return json(res, state.perks.filter((x) => !x.used));
            if (group === "perks" && id && req.method === "PUT") {
                const perk = state.perks.find((x) => x.id === id);
                Object.assign(perk, { used: Boolean((await readBody(req)).used) });
                return json(res, perk);
            }
            if (group === "offers" && id === "bulk") {
                const b = await readBody(req);
                for (const o of b.offers) state.offers.push({ ...o, cardId: b.cardId });
                return json(res, { received: b.offers.length, created: b.offers.length, updated: 0 }, 201);
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
            const ACCOUNTS = { c1: ["Sapphire Preferred (...9876)", "OQX90"], c3: ["Gold Card (...3001)", "GLD31"] };
            const acct = (document.cookie.match(/acct=(c[0-9])/) || [])[1] || "c1";
            function switcher() {
                const h = el("header"); h.id = "acct";
                const b = el("button", ACCOUNTS[acct][0] + " ▾"); b.setAttribute("aria-haspopup", "listbox"); b.setAttribute("aria-expanded", "false");
                const list = el("ul"); list.setAttribute("role", "listbox"); list.hidden = true;
                for (const [id, [name, key]] of Object.entries(ACCOUNTS)) {
                    const li = el("li", name); li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(id === acct));
                    li.addEventListener("click", () => { document.cookie = "acct=" + id + "; path=/"; history.replaceState({}, "", location.pathname + "?opaqueAccountId=" + key); location.reload(); });
                    list.append(li);
                }
                b.addEventListener("click", () => { list.hidden = !list.hidden; b.setAttribute("aria-expanded", String(!list.hidden)); });
                h.append(b, list);
                return h;
            }
            function nav() {
                const n = el("nav");
                for (const [href, text, spa] of [["/bank/help", "Help"], ["/bank/offers", "Offers"], ["/bank/benefits", "Benefits"], ["/bank/rewards?opaqueAccountId=OQX90", "Ultimate Rewards"], ["/bank/rewards?opaqueAccountId=OQX90", "Rewards (in-app)", true]]) {
                    const a = el("a", text); a.href = href;
                    if (spa) { a.id = "spa-link"; a.addEventListener("click", (e) => { e.preventDefault(); history.pushState({}, "", href); setTimeout(draw, 800); }); }
                    n.append(a, " ");
                }
                return n;
            }
            function draw() {
                const root = document.getElementById("root");
                root.replaceChildren(nav());
                if (location.pathname !== "/bank/dashboard") root.append(switcher());
                if (location.pathname === "/bank/dashboard") {
                    root.append(tile([["Sapphire Preferred (...9876)"], ["Current balance"], ["$1,111.00", true]]));
                    if (location.search.includes("promo")) root.append(tile([["Welcome offer"], ["2,000", true], ["bonus points"]]));
                } else if (location.pathname === "/bank/rewards") {
                    root.append(
                        tile([["Freedom Unlimited (...1234)"], ["Cash back rewards"], ["12,345", true], ["points"]]),
                        acct === "c3" ? tile([["Gold Card (...3001)"], ["Membership Rewards"], ["45,000", true], ["points"]]) : tile([["Sapphire Preferred (...9876)"], ["Ultimate Rewards"], [more ? "99,265" : "98,765", true], ["points"]]),
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
                    const offers = acct === "c3" ? [["Saks", "Spend $250, get $50 back", false], ["Hilton", "Earn 5,000 points", false]] : [["Best Buy", "Spend $100, get $15 back", false], ["Chipotle", "5% back", true], ["Delta", "Earn 2,000 points", false]];
                    for (const [merchant, badge, added] of offers) {
                        const t = tile([[merchant], [badge], ["Expires Dec 31, 2026"]]);
                        const b = el("button", added ? "Added" : "Add to Card");
                        b.addEventListener("click", () => { b.textContent = "Added"; });
                        t.append(b); root.append(t);
                    }
                } else if (location.pathname === "/bank/benefits") {
                    if (acct === "c3") root.append(tile([["Dining Credit"], ["$10 of $10 used"]]));
                    else root.append(tile([["Uber Cash"], ["$10 of $10 used"]]), tile([["Digital Entertainment Credit"], ["$5 of $20 used"]]));
                }
            }
            setTimeout(draw, 1200);`, h);
        if (p === "/bank/login" && req.method === "POST") { res.writeHead(302, { location: "/bank/dashboard", "set-cookie": "bank=1; Path=/" }); return res.end(); }
        const signedIn = /(^|;\s*)bank=1/.test(req.headers.cookie || "");
        const pages = ["/bank/dashboard", "/bank/rewards", "/bank/offers", "/bank/benefits"];
        if (pages.includes(p) && !signedIn) { res.writeHead(302, { location: "/bank/login" }); return res.end(); }
        if (p === "/bank/login") return send(res, 200, "text/html", page("Sign in", `<form method="post" action="/bank/login"><input name="user" autocomplete="username"><input type="password" name="pw"><button>Sign in</button></form>`), h);
        if (p === "/bank/rewards") h["content-security-policy"] = `${csp}; require-trusted-types-for 'script'`;
        if (pages.includes(p)) return send(res, 200, "text/html", page("Bank", `<div id="root">Loading…</div><script src="/bank/app.js"></script>`), h);
        return send(res, 404, "text/plain", "not found");
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}
