// Which spending category a website belongs to, so the extension can say which card earns most there.
// Categories match the dashboard's card earn rates: dining, groceries, gas, travel, streaming, online, other.

export const CATEGORY_LABELS = {
    dining: "Dining",
    groceries: "Groceries",
    gas: "Gas",
    travel: "Travel",
    streaming: "Streaming",
    online: "Online shopping",
    other: "Everything else",
};

// domain → [merchant name, category]. Subdomains match (www.amazon.com → amazon.com).
const SITES = {
    // Online shopping
    "amazon.com": ["Amazon", "online"], "walmart.com": ["Walmart", "online"], "target.com": ["Target", "online"],
    "bestbuy.com": ["Best Buy", "online"], "ebay.com": ["eBay", "online"], "etsy.com": ["Etsy", "online"],
    "costco.com": ["Costco", "online"], "homedepot.com": ["The Home Depot", "online"], "lowes.com": ["Lowe's", "online"],
    "wayfair.com": ["Wayfair", "online"], "ikea.com": ["IKEA", "online"], "macys.com": ["Macy's", "online"],
    "nordstrom.com": ["Nordstrom", "online"], "kohls.com": ["Kohl's", "online"], "sephora.com": ["Sephora", "online"],
    "ulta.com": ["Ulta Beauty", "online"], "nike.com": ["Nike", "online"], "adidas.com": ["adidas", "online"],
    "lululemon.com": ["lululemon", "online"], "gap.com": ["Gap", "online"], "oldnavy.com": ["Old Navy", "online"],
    "zara.com": ["Zara", "online"], "hm.com": ["H&M", "online"], "uniqlo.com": ["Uniqlo", "online"],
    "rei.com": ["REI", "online"], "chewy.com": ["Chewy", "online"], "petco.com": ["Petco", "online"],
    "petsmart.com": ["PetSmart", "online"], "apple.com": ["Apple", "online"], "samsung.com": ["Samsung", "online"],
    "dell.com": ["Dell", "online"], "newegg.com": ["Newegg", "online"], "bhphotovideo.com": ["B&H Photo", "online"],
    "staples.com": ["Staples", "online"], "officedepot.com": ["Office Depot", "online"], "cvs.com": ["CVS", "online"],
    "walgreens.com": ["Walgreens", "online"], "shein.com": ["SHEIN", "online"], "temu.com": ["Temu", "online"],
    "overstock.com": ["Overstock", "online"], "zappos.com": ["Zappos", "online"], "dickssportinggoods.com": ["Dick's Sporting Goods", "online"],
    "bathandbodyworks.com": ["Bath & Body Works", "online"], "williams-sonoma.com": ["Williams Sonoma", "online"],
    "potterybarn.com": ["Pottery Barn", "online"], "crateandbarrel.com": ["Crate & Barrel", "online"],
    "samsclub.com": ["Sam's Club", "online"], "bjs.com": ["BJ's", "online"], "aliexpress.com": ["AliExpress", "online"],
    // Groceries
    "instacart.com": ["Instacart", "groceries"], "wholefoodsmarket.com": ["Whole Foods", "groceries"],
    "kroger.com": ["Kroger", "groceries"], "safeway.com": ["Safeway", "groceries"], "albertsons.com": ["Albertsons", "groceries"],
    "publix.com": ["Publix", "groceries"], "wegmans.com": ["Wegmans", "groceries"], "heb.com": ["H-E-B", "groceries"],
    "traderjoes.com": ["Trader Joe's", "groceries"], "aldi.us": ["ALDI", "groceries"], "sprouts.com": ["Sprouts", "groceries"],
    "freshdirect.com": ["FreshDirect", "groceries"], "gopuff.com": ["Gopuff", "groceries"], "shipt.com": ["Shipt", "groceries"],
    "vons.com": ["Vons", "groceries"], "ralphs.com": ["Ralphs", "groceries"], "stopandshop.com": ["Stop & Shop", "groceries"],
    "giantfood.com": ["Giant", "groceries"], "foodlion.com": ["Food Lion", "groceries"], "harristeeter.com": ["Harris Teeter", "groceries"],
    // Dining and delivery
    "doordash.com": ["DoorDash", "dining"], "ubereats.com": ["Uber Eats", "dining"], "grubhub.com": ["Grubhub", "dining"],
    "seamless.com": ["Seamless", "dining"], "postmates.com": ["Postmates", "dining"], "caviar.com": ["Caviar", "dining"],
    "opentable.com": ["OpenTable", "dining"], "resy.com": ["Resy", "dining"], "toasttab.com": ["Toast", "dining"],
    "starbucks.com": ["Starbucks", "dining"], "chipotle.com": ["Chipotle", "dining"], "dominos.com": ["Domino's", "dining"],
    "pizzahut.com": ["Pizza Hut", "dining"], "papajohns.com": ["Papa Johns", "dining"], "mcdonalds.com": ["McDonald's", "dining"],
    "chick-fil-a.com": ["Chick-fil-A", "dining"], "panerabread.com": ["Panera", "dining"], "sweetgreen.com": ["sweetgreen", "dining"],
    "dunkindonuts.com": ["Dunkin'", "dining"], "goldbelly.com": ["Goldbelly", "dining"], "tock.com": ["Tock", "dining"],
    // Travel
    "expedia.com": ["Expedia", "travel"], "booking.com": ["Booking.com", "travel"], "hotels.com": ["Hotels.com", "travel"],
    "priceline.com": ["Priceline", "travel"], "kayak.com": ["KAYAK", "travel"], "orbitz.com": ["Orbitz", "travel"],
    "airbnb.com": ["Airbnb", "travel"], "vrbo.com": ["Vrbo", "travel"], "marriott.com": ["Marriott", "travel"],
    "hilton.com": ["Hilton", "travel"], "hyatt.com": ["Hyatt", "travel"], "ihg.com": ["IHG", "travel"],
    "wyndhamhotels.com": ["Wyndham", "travel"], "choicehotels.com": ["Choice Hotels", "travel"],
    "delta.com": ["Delta", "travel"], "united.com": ["United", "travel"], "aa.com": ["American Airlines", "travel"],
    "southwest.com": ["Southwest", "travel"], "jetblue.com": ["JetBlue", "travel"], "alaskaair.com": ["Alaska Airlines", "travel"],
    "spirit.com": ["Spirit", "travel"], "flyfrontier.com": ["Frontier", "travel"], "hawaiianairlines.com": ["Hawaiian Airlines", "travel"],
    "britishairways.com": ["British Airways", "travel"], "aircanada.com": ["Air Canada", "travel"], "lufthansa.com": ["Lufthansa", "travel"],
    "emirates.com": ["Emirates", "travel"], "qatarairways.com": ["Qatar Airways", "travel"], "amtrak.com": ["Amtrak", "travel"],
    "hertz.com": ["Hertz", "travel"], "avis.com": ["Avis", "travel"], "enterprise.com": ["Enterprise", "travel"],
    "budget.com": ["Budget", "travel"], "nationalcar.com": ["National", "travel"], "sixt.com": ["Sixt", "travel"],
    "turo.com": ["Turo", "travel"], "uber.com": ["Uber", "travel"], "lyft.com": ["Lyft", "travel"],
    "travel.chase.com": ["Chase Travel", "travel"], "travel.capitalone.com": ["Capital One Travel", "travel"],
    "amextravel.com": ["Amex Travel", "travel"], "carnival.com": ["Carnival", "travel"], "royalcaribbean.com": ["Royal Caribbean", "travel"],
    "ncl.com": ["Norwegian Cruise Line", "travel"], "google.com/travel": ["Google Travel", "travel"],
    // Streaming
    "netflix.com": ["Netflix", "streaming"], "hulu.com": ["Hulu", "streaming"], "disneyplus.com": ["Disney+", "streaming"],
    "max.com": ["Max", "streaming"], "peacocktv.com": ["Peacock", "streaming"], "paramountplus.com": ["Paramount+", "streaming"],
    "spotify.com": ["Spotify", "streaming"], "tv.apple.com": ["Apple TV+", "streaming"], "music.apple.com": ["Apple Music", "streaming"],
    "youtube.com": ["YouTube", "streaming"], "tv.youtube.com": ["YouTube TV", "streaming"], "siriusxm.com": ["SiriusXM", "streaming"],
    "audible.com": ["Audible", "streaming"], "pandora.com": ["Pandora", "streaming"], "sling.com": ["Sling TV", "streaming"],
    "fubo.tv": ["Fubo", "streaming"], "crunchyroll.com": ["Crunchyroll", "streaming"],
    // Gas
    "shell.us": ["Shell", "gas"], "chevron.com": ["Chevron", "gas"], "exxon.com": ["Exxon", "gas"], "bp.com": ["bp", "gas"],
    "arco.com": ["ARCO", "gas"], "electrifyamerica.com": ["Electrify America", "gas"], "chargepoint.com": ["ChargePoint", "gas"],
};

const CHECKOUT = /\/(checkout|cart|basket|bag|payment|purchase|order\/review|book(ing)?\/(review|payment|confirm)|reservation\/(review|payment))(\b|\/|$)|[?&#](checkout|step=payment)/i;

/** Hostname without "www.", or "" for non-web URLs. */
export function hostOf(url) {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return "";
        return u.hostname.replace(/^www\d?\./, "").toLowerCase();
    } catch {
        return "";
    }
}

/** Known merchant for this URL: { name, category, domain }, or null. */
export function siteFor(url) {
    const host = hostOf(url);
    if (!host) return null;
    let path = "";
    try { path = new URL(url).pathname; } catch { /* ignore */ }
    // Path-specific entries first (google.com/travel), then the host and each parent domain.
    for (const key of Object.keys(SITES)) {
        if (key.includes("/") && `${host}${path}`.startsWith(key)) return site(key);
    }
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts.slice(i).join(".");
        if (SITES[key]) return site(key);
    }
    return null;
}
const site = (key) => ({ name: SITES[key][0], category: SITES[key][1], domain: key });

/** Cart, checkout and booking-payment pages. */
export function isCheckoutUrl(url) {
    try {
        const u = new URL(url);
        return CHECKOUT.test(u.pathname + u.search + u.hash);
    } catch {
        return false;
    }
}

/**
 * What to suggest for a page: a known merchant anywhere on its site, or any other site's checkout
 * page (counted as online shopping). Null otherwise.
 */
export function shoppingContext(url) {
    const known = siteFor(url);
    const checkout = isCheckoutUrl(url);
    if (known) return { ...known, checkout };
    if (!checkout) return null;
    const host = hostOf(url);
    if (!host) return null;
    return { name: host, category: "online", domain: host, checkout: true, guessed: true };
}

const squash = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

/** Does this saved offer belong to the merchant on screen? Matches by link or by name. */
export function offerMatchesSite(offer, context) {
    if (!offer || !context) return false;
    const offerHost = hostOf(offer.merchantUrl || "");
    if (offerHost && (offerHost === context.domain || offerHost.endsWith(`.${context.domain}`))) return true;
    const a = squash(offer.merchant), b = squash(context.name), label = squash(context.domain.split(".")[0]);
    if (a.length < 3) return false;
    return a === b || a === label || (b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) || (label.length >= 4 && a.startsWith(label));
}
