// Fake Finstracker API and fake bank on http://localhost:3000, a host the extension may access.
import http from "node:http";
export function startServer({ port = 3000 } = {}) {
  const state = { points: 1000, transactions: [] };
  const card = () => ({ id: "c1", displayName: "Sapphire Preferred", issuer: "Mock Bank", rewardType: "points", currentPoints: state.points, currentCashBack: 0, pointValueCents: 1.25, multipliers: { dining: 3 }, program: "Chase Ultimate Rewards" });
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const send = (res, code, type, body, headers = {}) => { res.writeHead(code, { "content-type": type, ...headers }); res.end(body); };
  const json = (res, data, code = 200) => send(res, code, "application/json", JSON.stringify({ status: code, message: "OK", data }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    if (p === "/api/health") return json(res, { up: true });
    if (p.startsWith("/api/")) {
      if (req.headers.authorization !== "Bearer test-token") return json(res, null, 401);
      if (p === "/api/cards") return json(res, [card()]);
      if (p === "/api/cards/c1") return json(res, card());
      if (p === "/api/perks" || p === "/api/offers") return json(res, []);
      if (p === "/api/transactions" && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const t = JSON.parse(body); state.transactions.push(t);
        state.points += t.type === "earn" ? t.amount : -t.amount;
        return json(res, { transaction: t }, 201);
      }
      return json(res, null, 404);
    }
    const h = { "content-security-policy": csp, "cache-control": "no-store" };
    if (p === "/bank/app.js") return send(res, 200, "text/javascript", `
      // Single-page dashboard: content arrives late, like real bank portals.
      const route = location.pathname;
      setTimeout(() => {
        const root = document.getElementById("root");
        if (route === "/bank/dashboard") root.innerHTML = '<nav><a href="/bank/help">Help</a> <a href="/bank/offers">Offers</a> <a href="/bank/rewards">Ultimate Rewards</a></nav><div class="tile"><div>Sapphire Preferred (...9876)</div><div>Current balance</div><div style="font-size:28px">$1,111.00</div></div>';
        if (route === "/bank/rewards") root.innerHTML = '<div class="tile"><div>Freedom Unlimited (...1234)</div><div>Cash back rewards</div><div style="font-size:28px">12,345</div><div>points</div></div><div class="tile"><div>Sapphire Preferred (...9876)</div><div>Ultimate Rewards</div><div style="font-size:28px">98,765</div><div>points</div></div>';
      }, 1200);`, h);
    if (p === "/bank/login" && req.method === "POST") { res.writeHead(302, { location: "/bank/dashboard", "set-cookie": "bank=1; Path=/" }); return res.end(); }
    const signedIn = /(^|;\s*)bank=1/.test(req.headers.cookie || "");
    if ((p === "/bank/dashboard" || p === "/bank/rewards") && !signedIn) { res.writeHead(302, { location: "/bank/login" }); return res.end(); }
    if (p === "/bank/login") return send(res, 200, "text/html", page("Sign in", `<form method="post" action="/bank/login"><input name="user" autocomplete="username"><input type="password" name="pw"><button>Sign in</button></form>`), h);
    if (p === "/bank/dashboard" || p === "/bank/rewards") return send(res, 200, "text/html", page("Bank", `<div id="root">Loading…</div><script src="/bank/app.js"></script>`), h);
    return send(res, 404, "text/plain", "not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}
