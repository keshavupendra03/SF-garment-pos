// Shared helpers for the POS components. computeBill mirrors PosBillCalc.compute (Apex)
// for the live preview; the server recomputes and its numbers are the ones saved.
import FORM_FACTOR from '@salesforce/client/formFactor';
import { NavigationMixin } from 'lightning/navigation';

export const PAY_MODES = ['CASH', 'UPI', 'CARD', 'CREDIT'];

export const PAY_MODE_META = {
    CASH: { label: 'Cash', icon: 'utility:money' },
    UPI: { label: 'UPI', icon: 'utility:phone_portrait' },
    CARD: { label: 'Card', icon: 'utility:payment_gateway' },
    CREDIT: { label: 'Credit', icon: 'utility:clock' },
    // Not offered as payment tiles: CN = credit note redeemed in a bill; DUE = refund set off against dues.
    CN: { label: 'Credit note', icon: 'utility:note' },
    DUE: { label: 'Adjusted in dues', icon: 'utility:clock' }
};

export function payLabel(mode) {
    return PAY_MODE_META[mode] ? PAY_MODE_META[mode].label : mode;
}

export function isCreditNote(doc) {
    return Boolean(doc) && doc.k === 'CN';
}

export const IS_PHONE = FORM_FACTOR === 'Small';
export const IS_DESKTOP = FORM_FACTOR === 'Large';

export function num(value, fallback = 0) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const n = Number(value);
    return Number.isNaN(n) ? fallback : n;
}

export function round2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

const inr = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

const inrWhole = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
});

export function money(value) {
    return inr.format(num(value));
}

export function moneyShort(value) {
    const n = num(value);
    return Number.isInteger(n) ? inrWhole.format(n) : inr.format(n);
}

export function isoDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** Today's date (yyyy-MM-dd) in the shop's time zone, independent of the device's clock zone. */
export function todayIn(timeZone) {
    try {
        // en-CA formats as yyyy-MM-dd
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timeZone || DEFAULT_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date());
    } catch (e) {
        return isoDate();
    }
}

/** Calendar arithmetic on yyyy-MM-dd strings (done in UTC so no time zone can shift the day). */
export function addDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export function monthStart(iso) {
    return `${iso.slice(0, 7)}-01`;
}

export function formatBytes(bytes) {
    const b = num(bytes);
    if (b < 1024) {
        return `${b} B`;
    }
    if (b < 1024 * 1024) {
        return `${(b / 1024).toFixed(1)} KB`;
    }
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

export function initials(name, fallback = '#') {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
        return fallback;
    }
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function parseNdjson(text) {
    return (text || '')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
}

export function receiptUrl(bill) {
    return `/apex/PosReceipt?d=${bill.dt.replace(/-/g, '')}&no=${encodeURIComponent(bill.no)}`;
}

export function whatsappUrl(mobile, text) {
    const to = mobile && /^[0-9]{10}$/.test(mobile) ? `91${mobile}` : '';
    return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export function shareText(bill, storeName) {
    if (isCreditNote(bill)) {
        return creditNoteText(bill, storeName);
    }
    const lines = [];
    if (storeName) {
        lines.push(`*${storeName}*`);
    }
    lines.push(`Bill ${bill.no} · ${bill.dt} ${bill.tm}`);
    lines.push('');
    (bill.l || []).forEach((l) => {
        const variant = [l.z, l.c].filter(Boolean).join('/');
        lines.push(`${l.n}${variant ? ` (${variant})` : ''} ×${l.q}  ${money(l.net)}`);
    });
    lines.push('');
    if (num(bill.dis) > 0) {
        lines.push(`You saved ${money(bill.dis)}`);
    }
    lines.push(`*Total ${money(bill.g)}*`);
    lines.push(`Paid: ${(bill.pay || []).map((p) => `${payLabel(p.m)}${p.ref ? ` ${p.ref}` : ''} ${money(p.a)}`).join(', ')}`);
    if (num(bill.due) > 0) {
        lines.push(`On credit: ${money(bill.due)}`);
    }
    if (num(bill.pts) > 0) {
        lines.push(`Points earned: ${bill.pts}`);
    }
    lines.push('');
    lines.push('Thank you for shopping with us!');
    return lines.join('\n');
}

function creditNoteText(note, storeName) {
    const lines = [];
    if (storeName) {
        lines.push(`*${storeName}*`);
    }
    lines.push(`Credit note ${note.no} · ${note.dt} ${note.tm}`);
    lines.push(`Against bill ${note.ref} (${note.rdt})`);
    lines.push('');
    lines.push('Returned:');
    (note.l || []).forEach((l) => {
        const variant = [l.z, l.c].filter(Boolean).join('/');
        lines.push(`${l.n}${variant ? ` (${variant})` : ''} ×${l.q}  ${money(l.net)}`);
    });
    lines.push('');
    lines.push(`*Credit ${money(note.g)}*`);
    (note.pay || []).forEach((p) => lines.push(`Refunded: ${payLabel(p.m)} ${money(p.a)}`));
    if (num(note.bal) > 0) {
        lines.push(`Balance on this note: ${money(note.bal)}`);
        lines.push('Show this note on your next visit to use it.');
    }
    return lines.join('\n');
}

/** What a return of `qty` pieces of a sold line is worth: the share actually paid, incl. GST. */
export function returnLineValue(line, qty) {
    const sold = num(line.q);
    if (!sold || !qty) {
        return { amount: 0, tax: 0 };
    }
    return { amount: round2((num(line.net) * qty) / sold), tax: round2((num(line.tx) * qty) / sold) };
}

/** Whole days between two yyyy-MM-dd dates. */
export function daysBetween(fromIso, toIso) {
    return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

/**
 * Opens a URL from a component that extends NavigationMixin(LightningElement).
 * Desktop keeps the POS open by using a new browser tab; the mobile app needs
 * NavigationMixin to hand the URL to its in-app browser / WhatsApp.
 */
export function openUrl(cmp, url) {
    if (IS_DESKTOP) {
        window.open(url, '_blank');
        return;
    }
    cmp[NavigationMixin.Navigate]({ type: 'standard__webPage', attributes: { url } });
}

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', 'FREE'];

export function compareSizes(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
        return na - nb;
    }
    const ia = SIZE_ORDER.indexOf(String(a).toUpperCase());
    const ib = SIZE_ORDER.indexOf(String(b).toUpperCase());
    if (ia !== -1 && ib !== -1) {
        return ia - ib;
    }
    if (ia !== -1) {
        return -1;
    }
    if (ib !== -1) {
        return 1;
    }
    return String(a).localeCompare(String(b));
}

const EXTRA_COLORS = {
    mustard: '#e1ad01',
    charcoal: '#36454f',
    offwhite: '#f5f5ec',
    cream: '#fffdd0',
    wine: '#722f37',
    rust: '#b7410e',
    peach: '#ffcba4',
    mint: '#98e0b0',
    multi: 'linear-gradient(135deg,#e53935,#fdd835,#43a047,#1e88e5)'
};

export function swatchStyle(color) {
    const key = (color || '').replace(/\s+/g, '').toLowerCase();
    if (EXTRA_COLORS[key]) {
        return `background:${EXTRA_COLORS[key]}`;
    }
    try {
        if (key && window.CSS && window.CSS.supports('color', key)) {
            return `background:${key}`;
        }
    } catch (e) {
        // fall through to neutral swatch
    }
    return 'background:#c9c9c9';
}

export function errorMessage(error) {
    if (!error) {
        return 'Unknown error';
    }
    if (error.body) {
        if (Array.isArray(error.body)) {
            return error.body.map((e) => e.message).join(', ');
        }
        if (error.body.message) {
            return error.body.message;
        }
    }
    return error.message || String(error);
}

/**
 * @param store  POS_Store__c settings (tax slabs)
 * @param cart   [{ id, price, q, dp }]  price is GST inclusive, dp = item discount %
 * @param billDiscount flat amount off the whole bill
 */
export function computeBill(store, cart, billDiscount) {
    const s = store || {};
    const low = num(s.Tax_Rate_Low__c, 5);
    const high = num(s.Tax_Rate_High__c, 18);
    const threshold = num(s.Tax_Threshold__c, 2500);

    const lines = cart.map((c) => {
        const gross = round2(c.price * c.q);
        const ld = round2((gross * num(c.dp)) / 100);
        return { ...c, gross, ld, net0: round2(gross - ld) };
    });
    const totalNet0 = round2(lines.reduce((t, l) => t + l.net0, 0));
    const bd = Math.min(Math.max(round2(num(billDiscount)), 0), totalNet0);

    let allocated = 0;
    lines.forEach((l, i) => {
        const share =
            i === lines.length - 1 ? round2(bd - allocated) : totalNet0 ? round2((bd * l.net0) / totalNet0) : 0;
        allocated = round2(allocated + share);
        l.bs = share;
        l.net = round2(l.net0 - share);
        const unit = l.q ? l.net / l.q : 0;
        l.rate = unit / (1 + low / 100) <= threshold ? low : high;
        l.tax = round2(l.net - l.net / (1 + l.rate / 100));
    });

    const sum = (key) => round2(lines.reduce((t, l) => t + l[key], 0));
    const net = sum('net');
    const grand = Math.round(net);
    const itemDiscount = sum('ld');
    return {
        lines,
        items: lines.reduce((t, l) => t + l.q, 0),
        sub: sum('gross'),
        itemDiscount,
        bd,
        dis: round2(itemDiscount + bd),
        tax: sum('tax'),
        ro: round2(grand - net),
        g: grand
    };
}
