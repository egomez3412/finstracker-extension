// Runs in the extension's isolated world. Only a benefit's own text is passed here.
(function () {
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const NUMBER = '[\\d,]+(?:\\.\\d{1,2})?';
    const amount = value => Number(String(value).replace(/[$,\s]/g, ''));
    const round = value => Math.round(value * 100) / 100;

    function parse(title, raw, today = new Date().toLocaleDateString('en-CA')) {
        const text = String(raw).replace(/[\u00a0\u202f]/g, ' ');
        title = String(title).replace(/[®™‡*]/g, '').trim();
        if (/^congratulations!?$/i.test(title)) {
            const named = text.match(/of (?:your|the) (.+?) credit benefit/i);
            if (named) title = `${named[1]} credit`;
        }
        if (!/credit|cash|promo|membership|saks|dunkin|resy|lululemon|walmart|clear|oura|home chef|disney|entertainment|uber/i.test(title)) return null;
        if (/guest access|sky club access|spend progress|bonus points|earn.*points|\d+x\b/i.test(title)) return null;
        const year = Number(today.slice(0, 4)), currentMonth = Number(today.slice(5, 7)) - 1;
        if (!Number.isInteger(year) || currentMonth < 0 || currentMonth > 11) return null;

        const dated = [...text.matchAll(new RegExp(`\\$\\s*(${NUMBER})\\s*(?:earned|received|used|redeemed|credited)\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\\s*[-–—]\\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)?`, 'gi'))];
        const current = dated.find(match => {
            const start = MONTHS.indexOf(match[2].toLowerCase()), end = match[3] ? MONTHS.indexOf(match[3].toLowerCase()) : start;
            return currentMonth >= start && currentMonth <= end;
        });
        let cadence = null, startMonth = 0, endMonth = 11, anniversaryPeriod = null;
        if (/account anniversary year|cardmember year/i.test(text)) {
            const next = text.match(/after your statement closing date on (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
            if (!next) return null;
            const endYear = Number(next[3]), month = Number(next[1]) - 1, day = Number(next[2]);
            const end = new Date(Date.UTC(endYear, month, day));
            if (end.getUTCFullYear() !== endYear || end.getUTCMonth() !== month || end.getUTCDate() !== day) return null;
            const priorDay = Math.min(day, new Date(Date.UTC(endYear - 1, month + 1, 0)).getUTCDate());
            const start = new Date(Date.UTC(endYear - 1, month, priorDay + 1));
            anniversaryPeriod = { start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10) };
            if (today < anniversaryPeriod.start || today > anniversaryPeriod.end) return null;
            cadence = 'annual';
        } else if (current) {
            startMonth = MONTHS.indexOf(current[2].toLowerCase());
            endMonth = current[3] ? MONTHS.indexOf(current[3].toLowerCase()) : startMonth;
            cadence = ({1:'monthly',3:'quarterly',6:'semi-annual',12:'annual'})[endMonth - startMonth + 1] || null;
        } else if (/semi[- ]?annu|twice (a|per) year/i.test(text)) {
            cadence = 'semi-annual'; startMonth = currentMonth < 6 ? 0 : 6; endMonth = startMonth + 5;
        } else if (/quarterly|each quarter|per quarter/i.test(text)) {
            cadence = 'quarterly'; startMonth = Math.floor(currentMonth / 3) * 3; endMonth = startMonth + 2;
        } else if (/monthly|each (calendar )?month|per month|this month/i.test(text) && !/every \d+ years/i.test(text)) {
            cadence = 'monthly'; startMonth = endMonth = currentMonth;
        } else if (/annual|calendar year|this year|each year|per year/i.test(text) && !/cardmember year|anniversary|every \d+ years/i.test(text)) cadence = 'annual';

        let used = current ? amount(current[1]) : null, remaining = null, total = null;
        const usageText = text.replace(/(?:earned|received|used) this year\s*:?\s*\$\s*[\d,.]+/gi, '');
        const of = usageText.match(new RegExp(`\\$\\s*(${NUMBER})\\s*(?:of|/|out of)\\s*\\$\\s*(${NUMBER})`, 'i'));
        if (of) { used ??= amount(of[1]); total = amount(of[2]); }
        const left = usageText.match(new RegExp(`\\$\\s*(${NUMBER})\\s*(?:remaining|left|available|to go)`, 'i'));
        if (left) remaining = amount(left[1]);
        const earned = usageText.match(new RegExp(`\\$\\s*(${NUMBER})\\s*(?:used|earned|redeemed|spent|received|credited|applied)\\b`, 'i'));
        if (earned && !dated.length) used ??= amount(earned[1]);
        if (used != null && remaining != null) total ??= round(used + remaining);
        // "You've received $25 of your ... this month" is current-period evidence.
        const full = text.match(new RegExp(`(?:you['’]ve|you have) (?:received|earned|used)(?: the full)?\\s*\\$\\s*(${NUMBER})`, 'i'));
        if (full && !dated.length && !/last (month|quarter|year)/i.test(text)) {
            used ??= amount(full[1]); total ??= amount(full[1]); remaining ??= 0;
        }
        const headingCap = title.match(new RegExp(`^\\$\\s*(${NUMBER})\\s+`));
        if (total == null && headingCap) {
            const annualCap = amount(headingCap[1]);
            const annualHeading = /annual|\$\s*[\d,.]+\s+(digital entertainment|dining|resy|dunkin|lululemon|lodging|hotel|disney|home chef)/i.test(title);
            const divisor = annualHeading ? ({monthly:12,quarterly:4,'semi-annual':2})[cadence] || 1 : 1;
            total = round(annualCap / divisor);
        }
        if (total == null) {
            const periodic = text.match(new RegExp(`(?:get|receive|save)\\s+(?:up to\\s+)?\\$\\s*(${NUMBER})\\s*(?:off|back|in (?:statement )?credits?)?\\s*(?:each|per|a)\\s+(?:calendar\\s+)?(month|quarter|year)\\b`, 'i'));
            if (periodic && ({month:'monthly',quarter:'quarterly',year:'annual'})[periodic[2].toLowerCase()] === cadence) total = amount(periodic[1]);
        }
        const enrollment = /not unlocked/i.test(text) ? 'not-unlocked' : /enrollment required|activation required|enroll now/i.test(text) && used == null && remaining == null ? 'required' : /activated|enrolled/i.test(text) ? 'active' : 'unknown';
        if (!cadence || title.length > 160 || !(total > 0) || total > 10000 || used != null && used > total || remaining != null && remaining > total) return null;
        const usageKnown = (used != null || remaining != null) && (!dated.length || Boolean(current));
        if (!usageKnown) { used = null; remaining = null; }
        if (used == null && remaining != null) used = round(total - remaining);
        if (remaining == null && used != null) remaining = round(total - used);
        const fullyUsed = usageKnown && used >= total;
        return {
            title: title.replace(/^\$\s*[\d,.]+\s+/, '').replace(/\s*\(formerly known as[^)]*\)/i, '').trim(),
            total, used, remaining, fullyUsed, usageKnown, cadence, enrollment,
            periodStart: anniversaryPeriod?.start || `${year}-${String(startMonth + 1).padStart(2,'0')}-01`,
            periodEnd: anniversaryPeriod?.end || new Date(Date.UTC(year, endMonth + 1, 0)).toISOString().slice(0,10),
        };
    }
    window.__finsBenefitParser = { parse };
})();
