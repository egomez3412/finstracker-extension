// Where a card's points actually live. Co-branded cards keep their balance on the airline or hotel
// site (Delta SkyMiles on delta.com, Marriott Bonvoy on marriott.com), not on the bank's site.
// Each entry: words that identify it in a card name or program, its sign-in page, its points page,
// the sites it runs on, and words printed next to the balance there.

export const PROGRAM_PORTALS = {
    delta: { name: "Delta SkyMiles", words: ["skymiles", "delta"], loginUrl: "https://www.delta.com/login/loginPage", pointsUrlHint: "https://www.delta.com/myprofile/skymiles-overview", matchUrl: "https://*.delta.com/*", keywords: ["skymiles", "miles available", "miles balance"] },
    united: { name: "United MileagePlus", words: ["mileageplus", "united"], loginUrl: "https://www.united.com/en/us/signin", pointsUrlHint: "https://www.united.com/en/us/myunited", matchUrl: "https://*.united.com/*", keywords: ["mileageplus", "award miles", "miles"] },
    southwest: { name: "Southwest Rapid Rewards", words: ["rapid rewards", "southwest"], loginUrl: "https://www.southwest.com/myaccount/login", pointsUrlHint: "https://www.southwest.com/loyalty/myaccount/", matchUrl: "https://*.southwest.com/*", keywords: ["rapid rewards", "available points", "points"] },
    american: { name: "American AAdvantage", words: ["aadvantage", "american airlines"], loginUrl: "https://www.aa.com/login/loginAccess", pointsUrlHint: "https://www.aa.com/aadvantage-program/profile/account-summary", matchUrl: "https://*.aa.com/*", keywords: ["aadvantage", "award miles", "miles"] },
    alaska: { name: "Alaska Mileage Plan", words: ["mileage plan", "alaska", "atmos"], loginUrl: "https://www.alaskaair.com/account/login", pointsUrlHint: "https://www.alaskaair.com/account/overview", matchUrl: "https://*.alaskaair.com/*", keywords: ["mileage plan", "atmos", "available miles", "points"] },
    jetblue: { name: "JetBlue TrueBlue", words: ["trueblue", "jetblue"], loginUrl: "https://www.jetblue.com/signin", pointsUrlHint: "https://trueblue.jetblue.com/dashboard", matchUrl: "https://*.jetblue.com/*", keywords: ["trueblue", "points"] },
    aeroplan: { name: "Air Canada Aeroplan", words: ["aeroplan", "air canada"], loginUrl: "https://www.aircanada.com/aeroplan/member/dashboard", pointsUrlHint: "https://www.aircanada.com/aeroplan/member/dashboard", matchUrl: "https://*.aircanada.com/*", keywords: ["aeroplan points", "points"] },
    avios: { name: "British Airways Avios", words: ["avios", "british airways"], loginUrl: "https://www.britishairways.com/travel/loginr/public/en_us", pointsUrlHint: "https://www.britishairways.com/travel/viewaccount/execclub/_gf/en_us", matchUrl: "https://*.britishairways.com/*", keywords: ["avios"] },
    "flying-blue": { name: "Air France/KLM Flying Blue", words: ["flying blue", "air france", "klm"], loginUrl: "https://www.flyingblue.com/en/account", pointsUrlHint: "https://www.flyingblue.com/en/account", matchUrl: "https://*.flyingblue.com/*", keywords: ["miles"] },
    marriott: { name: "Marriott Bonvoy", words: ["bonvoy", "marriott"], loginUrl: "https://www.marriott.com/signIn.mi", pointsUrlHint: "https://www.marriott.com/loyalty/myAccount/default.mi", matchUrl: "https://*.marriott.com/*", keywords: ["bonvoy", "points"] },
    hilton: { name: "Hilton Honors", words: ["hilton", "honors"], loginUrl: "https://www.hilton.com/en/auth2/guest/login/", pointsUrlHint: "https://www.hilton.com/en/hilton-honors/guest/my-account/", matchUrl: "https://*.hilton.com/*", keywords: ["honors points", "points"] },
    hyatt: { name: "World of Hyatt", words: ["hyatt"], loginUrl: "https://www.hyatt.com/profile/en-US/sign-in", pointsUrlHint: "https://www.hyatt.com/profile/en-US/account-overview", matchUrl: "https://*.hyatt.com/*", keywords: ["current points", "points"] },
    ihg: { name: "IHG One Rewards", words: ["ihg"], loginUrl: "https://www.ihg.com/rewardsclub/us/en/sign-in", pointsUrlHint: "https://www.ihg.com/rewardsclub/us/en/account-mgmt/home", matchUrl: "https://*.ihg.com/*", keywords: ["points balance", "points"] },
    wyndham: { name: "Wyndham Rewards", words: ["wyndham"], loginUrl: "https://www.wyndhamhotels.com/wyndham-rewards/login", pointsUrlHint: "https://www.wyndhamhotels.com/wyndham-rewards/my-account", matchUrl: "https://*.wyndhamhotels.com/*", keywords: ["points"] },
    choice: { name: "Choice Privileges", words: ["choice privileges", "choice"], loginUrl: "https://www.choicehotels.com/choice-privileges/sign-in", pointsUrlHint: "https://www.choicehotels.com/choice-privileges/account", matchUrl: "https://*.choicehotels.com/*", keywords: ["points"] },
    amazon: { name: "Amazon rewards", words: ["amazon", "prime visa"], loginUrl: "https://www.amazon.com/cpe/yourpayments/wallet", pointsUrlHint: "https://www.amazon.com/cpe/yourpayments/wallet", matchUrl: "https://*.amazon.com/*", keywords: ["reward points", "rewards balance"] },
    bilt: { name: "Bilt Rewards", words: ["bilt"], loginUrl: "https://www.biltrewards.com/login", pointsUrlHint: "https://www.biltrewards.com/account", matchUrl: "https://*.biltrewards.com/*", keywords: ["bilt points", "points"] },
};

// Issuer names as people type them → the name portals.json uses.
const ISSUER_ALIASES = [
    [/american express|amex/i, "American Express"],
    [/chase|jp ?morgan/i, "Chase"],
    [/capital ?one/i, "Capital One"],
    [/citi(bank)?\b/i, "Citi"],
    [/discover/i, "Discover"],
    [/wells ?fargo/i, "Wells Fargo"],
    [/bank of america|\bbofa\b|\bboa\b/i, "Bank of America"],
    [/u\.? ?s\.? ?bank/i, "U.S. Bank"],
    [/barclay/i, "Barclays"],
];

/** The issuer name portals.json knows, for whatever spelling the card uses. */
export function normalizeIssuer(issuer) {
    const text = String(issuer || "");
    return ISSUER_ALIASES.find(([rx]) => rx.test(text))?.[1] || text;
}

// Bank-currency names: a card in these programs keeps its points at the bank, even if a word
// like "travel" or "rewards" appears in its name.
const BANK_CURRENCIES = /ultimate rewards|membership rewards|thankyou|venture|capital one miles|cashback|cash back|cash rewards/i;

/** The loyalty program a card's points belong to (key into PROGRAM_PORTALS), or null for bank points. */
export function programFor(card) {
    const program = String(card?.program || "");
    if (BANK_CURRENCIES.test(program)) return null;
    const text = `${program} ${card?.displayName || ""} ${card?.cardKey || ""}`.toLowerCase().replace(/-/g, " ");
    for (const [key, p] of Object.entries(PROGRAM_PORTALS)) {
        if (p.words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))) return key;
    }
    return null;
}

/** Words that sit next to this card's balance: its program, its name, its bank currency. */
export function balanceHints(card) {
    const key = programFor(card);
    const words = new Set(key ? PROGRAM_PORTALS[key].keywords : []);
    const program = String(card?.program || "").toLowerCase().trim();
    if (program && program.length <= 40) words.add(program.replace(/\s+(points|miles)$/, ""));
    const issuer = normalizeIssuer(card?.issuer);
    if (card?.rewardType === "cashback") {
        // Cash back is shown as dollars: Amex "Reward Dollars", Discover "Cashback Bonus", others "cash back".
        for (const w of ["reward dollars", "cashback bonus", "cash back", "cash rewards", "available rewards"]) words.add(w);
        if (program === "cash back") words.delete(program);
    } else {
        if (issuer === "Chase") words.add("ultimate rewards");
        if (issuer === "American Express") words.add("membership rewards");
        if (issuer === "Citi") words.add("thankyou");
        if (issuer === "Capital One") words.add("rewards balance");
    }
    const cardWords = nameWords(card).filter((w) => w.length >= 4 && !/^(signature|world|elite|preferred|rewards|business|plus|cash|back|points|miles)$/.test(w));
    const generic = new Set(["points", "miles", "rewards"]);
    return { keywords: [...words].filter((w) => w && !generic.has(w)), cardWords };
}

// Words that name the bank rather than the card ("Amex Gold" → "gold"), so they never tell cards apart.
const BRAND = new Set(["amex", "american", "express", "chase", "citi", "citibank", "capital", "one", "discover", "wells", "fargo", "barclays", "barclaycard", "synchrony", "bank", "america", "the", "card", "credit", "visa", "mastercard", "from", "with", "and"]);

/** A card's name words without bank and brand words, or words of its issuer's name. */
export function nameWords(card) {
    const issuerWords = new Set(`${card?.issuer || ""} ${normalizeIssuer(card?.issuer)}`.toLowerCase().split(/[^a-z0-9]+/));
    return String(card?.displayName || "").toLowerCase().split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !BRAND.has(w) && !issuerWords.has(w));
}

/**
 * The words that tell this card apart from the other cards on the same site
 * ("Blue Cash Preferred" vs "Blue Cash Everyday" → ["preferred"]). Falls back to all its name words.
 */
export function distinctWords(card, others = []) {
    const own = nameWords(card);
    const theirs = new Set(others.flatMap(nameWords));
    const distinct = own.filter((w) => !theirs.has(w));
    return distinct.length ? distinct : own;
}
