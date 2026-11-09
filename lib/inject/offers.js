// Runs inside issuer offer pages (see extractor.js).

/** Opens "show more" lists and scrolls virtualised lists so every offer tile is in the page. */
export async function expandOffersPage() {
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
}

// Reads merchant offer tiles: [{ merchant, title, valueCents, minSpendCents, discountType,
// discountValue, description, expiresAt, merchantUrl, category }].
export function offersPageScraper() {
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
