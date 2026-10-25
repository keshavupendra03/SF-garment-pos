// Receipt printing for the POS.
//  - buildReceipt() turns a saved bill into ESC/POS bytes for 58mm (32 col) or 80mm (48 col) thermal printers.
//  - printBill() hands those bytes to a Bluetooth bridge app (RawBT on Android, a configurable link on iOS),
//    or opens the HTML receipt page when the device is set to "page" printing.
// Printer settings are per device (a phone and the shop PC usually print differently), kept in localStorage.
import { IS_DESKTOP, PAY_MODE_META, num, openUrl, receiptUrl } from 'c/posUtils';
import { encode } from 'c/posBarcode';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const SETTINGS_KEY = 'garmentPos.printer';

// ---------- platform ----------

export function platform() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const touchMac = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
    if (/iPad|iPhone|iPod/.test(ua) || touchMac) {
        return 'ios';
    }
    if (/Android/i.test(ua)) {
        return 'android';
    }
    return IS_DESKTOP ? 'desktop' : 'other';
}

// ---------- settings ----------

export function defaultSettings() {
    const p = platform();
    return {
        method: p === 'android' ? 'bluetooth' : 'page',
        autoPrint: !IS_DESKTOP,
        width: 58,
        // 'image': CODE128 drawn by the app and printed as a raster image (exact bars on any printer).
        // 'codeset': the printer's own CODE128 command with "{B"/"{C" markers (strict Epson-style firmware).
        barcodeMode: 'image',
        tearFeed: DEFAULT_TEAR_FEED,
        iosTemplate: ''
    };
}

// Paper fed at the end of a job so the last line clears the tear edge (8 dots = 1 mm).
export const DEFAULT_TEAR_FEED = 80;
export const TEAR_FEEDS = [
    { dots: 48, label: 'Short' },
    { dots: 80, label: 'Normal' },
    { dots: 112, label: 'Long' }
];

export function loadSettings() {
    const defaults = defaultSettings();
    try {
        const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
        const settings = saved ? { ...defaults, ...saved } : defaults;
        // 'plain' (bare value to the printer's CODE128 command) made some printers emit GS1-128; retired.
        if (settings.barcodeMode !== 'codeset') {
            settings.barcodeMode = 'image';
        }
        return settings;
    } catch (e) {
        return defaults;
    }
}

export function saveSettings(settings) {
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        return true;
    } catch (e) {
        return false;
    }
}

export function columnsFor(width) {
    return Number(width) === 80 ? 48 : 32;
}

// ---------- ESC/POS builder ----------

// Thermal printers' default code page is ASCII-safe only; strip accents and replace the rupee sign.
function ascii(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/₹/g, 'Rs')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, '?');
}

function amt(value) {
    return num(value).toFixed(2);
}

class Receipt {
    constructor(cols) {
        this.cols = cols;
        this.bytes = [ESC, 0x40]; // initialize
    }

    raw(...values) {
        values.forEach((v) => this.bytes.push(v));
        return this;
    }

    align(where) {
        return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[where]);
    }

    bold(on) {
        return this.raw(ESC, 0x45, on ? 1 : 0);
    }

    // 'tall' doubles height only, so a line still holds `cols` characters.
    size(mode) {
        return this.raw(GS, 0x21, mode === 'tall' ? 0x01 : 0x00);
    }

    // Font B is the printer's small font (about 9x17 dots, so 42 columns on 58 mm).
    small(on) {
        return this.raw(ESC, 0x4d, on ? 1 : 0);
    }

    lineSpacing(dots) {
        return this.raw(ESC, 0x33, dots);
    }

    defaultSpacing() {
        return this.raw(ESC, 0x32);
    }

    // Feeds paper by an exact number of dots (8 dots = 1 mm), unlike LF which depends on line spacing.
    feedDots(dots) {
        let left = Math.max(0, Math.round(dots));
        while (left > 0) {
            const step = Math.min(255, left);
            this.raw(ESC, 0x4a, step);
            left -= step;
        }
        return this;
    }

    text(value) {
        const s = ascii(value);
        for (let i = 0; i < s.length; i++) {
            this.bytes.push(s.charCodeAt(i));
        }
        return this;
    }

    line(value = '') {
        return this.text(value).raw(LF);
    }

    rule() {
        return this.line('-'.repeat(this.cols));
    }

    wrap(value) {
        const words = ascii(value).split(/\s+/).filter(Boolean);
        let current = '';
        words.forEach((word) => {
            let w = word;
            while (w.length > this.cols) {
                if (current) {
                    this.line(current);
                    current = '';
                }
                this.line(w.slice(0, this.cols));
                w = w.slice(this.cols);
            }
            if (!current) {
                current = w;
            } else if (current.length + 1 + w.length <= this.cols) {
                current += ` ${w}`;
            } else {
                this.line(current);
                current = w;
            }
        });
        if (current) {
            this.line(current);
        }
        return this;
    }

    // Left text, right-aligned value on one line (or two if they don't fit).
    pair(left, right) {
        const l = ascii(left);
        const r = ascii(right);
        const room = this.cols - r.length;
        if (l.length + 1 > room) {
            this.line(l.slice(0, this.cols));
            return this.line(r.padStart(this.cols));
        }
        return this.line(l.padEnd(room) + r);
    }

    // Fixed-width columns; first column left-aligned, the rest right-aligned.
    row(cells, widths) {
        const out = cells
            .map((c, i) => {
                const s = ascii(c).slice(0, widths[i]);
                return i === 0 ? s.padEnd(widths[i]) : s.padStart(widths[i]);
            })
            .join('');
        return this.line(out);
    }

    feed(lines) {
        return this.raw(ESC, 0x64, lines);
    }
}

export function buildReceipt(bill, store, width = 58, feed = DEFAULT_TEAR_FEED) {
    const cols = columnsFor(width);
    const s = store || {};
    const r = new Receipt(cols);

    r.align('center').bold(true).size('tall').wrap(s.Name || 'Receipt').size('normal').bold(false);
    if (s.Address__c) {
        r.wrap(s.Address__c);
    }
    if (s.Phone__c) {
        r.line(`Ph: ${s.Phone__c}`);
    }
    if (s.GSTIN__c) {
        r.line(`GSTIN: ${s.GSTIN__c}`);
    }
    const isNote = bill.k === 'CN';
    r.bold(true).line(isNote ? 'CREDIT NOTE' : 'TAX INVOICE').bold(false);

    r.align('left').rule();
    r.line(`${isNote ? 'Note' : 'Bill'} : ${bill.no}`);
    r.line(`Date : ${bill.dt} ${bill.tm}`);
    if (isNote) {
        r.wrap(`Bill : ${bill.ref} (${bill.rdt})`);
        if (bill.rsn) {
            r.line(`Why  : ${bill.rsn}`.slice(0, cols));
        }
    }
    if (bill.cu) {
        r.wrap(`Cust : ${[bill.cu.n, bill.cu.m].filter(Boolean).join(' ')}`);
    }
    if (bill.by) {
        r.line(`By   : ${bill.by}`);
    }
    r.rule();

    (bill.l || []).forEach((l) => {
        r.bold(true).wrap(l.n).bold(false);
        const variant = [l.z, l.c].filter(Boolean).join('/');
        r.pair(` ${variant ? `${variant} ` : ''}${l.q} x ${amt(l.p)}`, amt(l.net));
        if (num(l.dp) > 0) {
            r.line(`  (${l.dp}% off)`);
        }
        if (isNote && l.rs === false) {
            r.line('  (damaged, not restocked)');
        }
    });
    r.rule();

    const pieces = (bill.l || []).reduce((t, l) => t + num(l.q), 0);
    r.pair(`Items: ${(bill.l || []).length}  Qty: ${pieces}`, '');
    r.pair('Gross', amt(bill.sub));
    if (num(bill.dis) > 0) {
        r.pair('Discount', `-${amt(bill.dis)}`);
    }
    if (num(bill.ro) !== 0) {
        r.pair('Round off', amt(bill.ro));
    }
    r.bold(true).size('tall').pair(isNote ? 'CREDIT' : 'TOTAL', `Rs ${amt(bill.g)}`).size('normal').bold(false);
    r.rule();

    // GST summary by rate, CGST/SGST split (intra-state).
    const byRate = new Map();
    (bill.l || []).forEach((l) => {
        const rate = num(l.r);
        const row = byRate.get(rate) || { taxable: 0, tax: 0 };
        row.taxable += num(l.net) - num(l.tx);
        row.tax += num(l.tx);
        byRate.set(rate, row);
    });
    const widths = cols === 48 ? [8, 16, 12, 12] : [5, 11, 8, 8];
    r.row(['GST%', 'Taxable', 'CGST', 'SGST'], widths);
    byRate.forEach((row, rate) => {
        const cgst = Math.round((row.tax / 2) * 100) / 100;
        r.row([`${rate}%`, amt(row.taxable), amt(cgst), amt(row.tax - cgst)], widths);
    });
    r.pair('Total GST (incl.)', amt(bill.tx));
    r.rule();

    (bill.pay || []).forEach((p) => {
        const label = PAY_MODE_META[p.m] ? PAY_MODE_META[p.m].label : p.m;
        r.pair(`${isNote ? 'Refund' : 'Paid'} ${label}${p.ref ? ` ${p.ref}` : ''}`, amt(p.a));
    });
    if (num(bill.chg) > 0) {
        r.pair('Change', amt(bill.chg));
    }
    if (num(bill.due) > 0) {
        r.pair('On credit (due)', amt(bill.due));
    }
    if (num(bill.pts) > 0) {
        r.pair('Points earned', String(bill.pts));
    }
    if (isNote && num(bill.bal) > 0) {
        r.bold(true).pair('Balance to use', `Rs ${amt(bill.bal)}`).bold(false);
    }

    // Bill/credit note number as a barcode: scan it to start a return or redeem the note.
    r.align('center');
    const code = encode(bill.no, width);
    if (code.ok) {
        r.raw(LF).small(true).line(isNote ? 'Scan to use this credit note' : 'Scan for returns & exchanges').small(false);
        barcode(r, code, 'image');
    }
    r.raw(LF);
    r.wrap(s.Receipt_Footer__c || 'Thank you for shopping with us!');
    return r.feedDots(feed).bytes;
}

export function buildTestPage(store, width = 58, feed = DEFAULT_TEAR_FEED) {
    const cols = columnsFor(width);
    const r = new Receipt(cols);
    r.align('center').bold(true).size('tall').line('PRINTER TEST').size('normal').bold(false);
    r.line((store && store.Name) || 'Garment POS');
    r.align('left').rule();
    r.line(`Paper: ${width}mm, ${cols} characters`);
    r.line('1234567890'.repeat(5).slice(0, cols));
    r.pair('Left', 'Right');
    r.bold(true).line('Bold text').bold(false);
    r.size('tall').line('Tall text').size('normal');
    r.rule();
    r.align('center').line('If every line fits on the paper,');
    r.line('the printer is set up correctly.');
    return r.feedDots(feed).bytes;
}

const BAR_HEIGHT = 64; // dots, ~8 mm at 203 dpi
const RASTER_QUIET = 10; // modules of white on each side
// Large raster jobs can exceed what the bridge app accepts in one hand-off.
export const MAX_JOB_BYTES = 350000;

// Draws the encoder's bars as a GS v 0 raster image, so the printer adds nothing of its own
// (portable printers' CODE128 commands may emit "{B" as data or switch to GS1-128 with FNC1).
function rasterBarcode(r, code) {
    const mw = code.moduleWidth;
    const widthDots = (code.bits.length + RASTER_QUIET * 2) * mw;
    const bytesPerRow = Math.ceil(widthDots / 8);
    const row = new Array(bytesPerRow).fill(0);
    for (let i = 0; i < code.bits.length; i++) {
        if (code.bits[i] === '1') {
            for (let d = 0; d < mw; d++) {
                const x = (i + RASTER_QUIET) * mw + d;
                row[x >> 3] |= 0x80 >> (x & 7);
            }
        }
    }
    r.raw(GS, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, BAR_HEIGHT & 0xff, BAR_HEIGHT >> 8);
    for (let y = 0; y < BAR_HEIGHT; y++) {
        r.raw(...row);
    }
    return r.line(code.value);
}

// ESC/POS barcode from an encode() result (posBarcode), with the value printed underneath.
function barcode(r, code, mode) {
    if (code.type !== 'EAN13' && mode !== 'codeset') {
        return rasterBarcode(r, code);
    }
    r.raw(GS, 0x68, BAR_HEIGHT);
    r.raw(GS, 0x77, code.moduleWidth);
    r.raw(GS, 0x48, 2); // human-readable text below
    r.raw(GS, 0x66, 0); // HRI font A
    if (code.type === 'EAN13') {
        r.raw(GS, 0x6b, 67, 13).text(code.value);
    } else if (code.set === 'C') {
        const pairs = [];
        for (let i = 0; i < code.value.length; i += 2) {
            pairs.push(Number(code.value.slice(i, i + 2)));
        }
        r.raw(GS, 0x6b, 73, pairs.length + 2, 0x7b, 0x43, ...pairs);
    } else {
        // '{' starts a code-set switch in ESC/POS CODE128 data, so a literal one is sent as '{{'.
        const data = code.value.replace(/\{/g, '{{');
        r.raw(GS, 0x6b, 73, data.length + 2, 0x7b, 0x42).text(data);
    }
    // The barcode command prints with its digits and leaves the head at the next line; no LF needed.
    return r;
}

const LABEL_LINE_DOTS = 24; // 3 mm lines on labels instead of the printer's ~3.75 mm default

/**
 * Barcode labels on receipt paper, packed one after another in a single job.
 * @param labels [{ code, copies, title, subtitle, price, mrp }] where `code` is a valid encode() result
 * @param options { shop: string|null, width: 58|80, mode: 'image'|'codeset', feed: dots fed at the end }
 */
export function buildBarcodeLabels(labels, { shop, width = 58, mode = 'image', feed = DEFAULT_TEAR_FEED } = {}) {
    const cols = columnsFor(width);
    const smallCols = Number(width) === 80 ? 64 : 42;
    const total = labels.reduce((t, l) => t + l.copies, 0);
    const r = new Receipt(cols);
    r.lineSpacing(LABEL_LINE_DOTS);
    let printed = 0;
    labels.forEach((label) => {
        for (let i = 0; i < label.copies; i++) {
            r.align('center');
            if (shop) {
                r.small(true).line(ascii(shop).slice(0, smallCols)).small(false);
            }
            if (label.title) {
                r.bold(true).wrap(label.title).bold(false);
            }
            if (label.subtitle) {
                r.wrap(label.subtitle);
            }
            r.feedDots(4);
            barcode(r, label.code, mode);
            if (num(label.mrp) > num(label.price)) {
                r.small(true).line(`MRP Rs ${amt(label.mrp)}`).small(false);
            }
            if (num(label.price) > 0) {
                r.bold(true).size('tall').line(`Rs ${amt(label.price)}`).size('normal').bold(false);
            }
            printed++;
            // Tear line only between labels; the printer's tear edge ends the last one.
            if (printed < total) {
                r.small(true).line('- '.repeat(smallCols / 2)).small(false);
            }
        }
    });
    return r.defaultSpacing().feedDots(feed).bytes;
}

/** Product price tags. Products without a printable barcode are skipped and reported. */
export function buildLabels(items, store, settings = loadSettings()) {
    const width = settings.width;
    const mode = settings.barcodeMode;
    const labels = [];
    const skipped = [];
    items.forEach(({ product: p, qty }) => {
        const code = encode(p.Barcode__c, width);
        if (!code.ok) {
            skipped.push(p);
            return;
        }
        labels.push({
            code,
            copies: qty,
            title: p.Name,
            subtitle: [p.Size__c, p.Color__c].filter(Boolean).join(' / '),
            price: p.Price__c,
            mrp: p.MRP__c
        });
    });
    return {
        bytes: buildBarcodeLabels(labels, { shop: store && store.Name, width, mode, feed: settings.tearFeed }),
        skipped
    };
}

export function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
    }
    return window.btoa(binary);
}

/** Link that hands ESC/POS bytes to the device's Bluetooth bridge app, or null if none is set up. */
export function bridgeUrl(bytes, settings) {
    const b64 = toBase64(bytes);
    if (platform() === 'ios') {
        const template = (settings.iosTemplate || '').trim();
        if (!template) {
            return null;
        }
        return template.includes('{base64}')
            ? template.replace('{base64}', encodeURIComponent(b64))
            : `${template}${encodeURIComponent(b64)}`;
    }
    return `rawbt:base64,${b64}`;
}

/**
 * Prints with the device's configured method. Returns { url, error } so the caller can show a
 * manual "tap to print" link (custom app links sometimes need a real tap inside the mobile app).
 */
export function printBytes(cmp, bytes, settings) {
    if (bytes.length > MAX_JOB_BYTES) {
        return { error: 'Too many labels for one print. Print them in smaller batches (about 50 at a time).' };
    }
    const url = bridgeUrl(bytes, settings);
    if (!url) {
        return { error: 'Set up iPhone printing in Settings first.' };
    }
    openUrl(cmp, url);
    return { url };
}

export function printBill(cmp, bill, store, settings = loadSettings()) {
    if (settings.method !== 'bluetooth') {
        openUrl(cmp, receiptUrl(bill));
        return {};
    }
    return printBytes(cmp, buildReceipt(bill, store, settings.width, settings.tearFeed), settings);
}
