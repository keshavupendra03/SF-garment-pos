// Barcode encoding shared by the on-screen preview (SVG) and the ESC/POS printer commands.
// EAN-13 for valid 12/13-digit codes, otherwise CODE128 (set C for even-length digits, set B for text).

// CODE128 bar/space widths for values 0..105, then STOP.
const CODE128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232'
];
const STOP = '2331112';
const START_B = 104;
const START_C = 105;

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

// Printable width in dots (203 dpi heads): 58mm paper -> 384, 80mm -> 576.
const PRINT_DOTS = { 58: 384, 80: 576 };
const QUIET_MODULES = 20;
const MIN_MODULE = 2; // thinner bars scan poorly from cheap thermal heads
const MAX_MODULE = 3;
export const MAX_LENGTH = 40;

export function eanCheckDigit(first12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return String((10 - (sum % 10)) % 10);
}

export function isEan13(code) {
    return /^[0-9]{13}$/.test(code) && eanCheckDigit(code.slice(0, 12)) === code[12];
}

/** Random in-store EAN-13 (prefix 29), distinct from product codes the server generates (prefix 20). */
export function randomEan13() {
    let body = '29';
    for (let i = 0; i < 10; i++) {
        body += Math.floor(Math.random() * 10);
    }
    return body + eanCheckDigit(body);
}

function widthsToBits(widths) {
    let bits = '';
    for (let i = 0; i < widths.length; i++) {
        bits += (i % 2 === 0 ? '1' : '0').repeat(Number(widths[i]));
    }
    return bits;
}

function encodeEan13(code) {
    const parity = EAN_PARITY[Number(code[0])];
    let bits = '101';
    for (let i = 1; i <= 6; i++) {
        bits += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[Number(code[i])];
    }
    bits += '01010';
    for (let i = 7; i <= 12; i++) {
        bits += EAN_R[Number(code[i])];
    }
    return bits + '101';
}

function code128Values(value, set) {
    const values = [];
    if (set === 'C') {
        for (let i = 0; i < value.length; i += 2) {
            values.push(Number(value.slice(i, i + 2)));
        }
    } else {
        for (let i = 0; i < value.length; i++) {
            values.push(value.charCodeAt(i) - 32);
        }
    }
    return values;
}

function encodeCode128(values, start) {
    let checksum = start;
    values.forEach((v, i) => {
        checksum += v * (i + 1);
    });
    const all = [start, ...values, checksum % 103];
    return all.map((v) => widthsToBits(CODE128[v])).join('') + widthsToBits(STOP);
}

/**
 * Cleans a scanned value so it matches the stored barcode. Labels printed through some printers'
 * own CODE128 command carry extras: a literal "{B" code-set marker, or GS1-128 framing that scanners
 * report as an AIM identifier ("]C1") and FNC1 (ASCII 29) separators.
 */
export function normalizeScan(code) {
    return (code || '')
        .trim()
        .replace(/^\][A-Za-z][0-9A-Za-z]/, '')
        .replace(/\x1d/g, '')
        .replace(/^\{[ABC]/, '')
        .trim();
}

/**
 * Validates and encodes a barcode value.
 * @returns {{ ok: boolean, error?: string, type?: string, set?: string, value?: string, bits?: string, moduleWidth?: number }}
 */
export function encode(raw, paperWidth = 58) {
    let value = (raw || '').trim();
    if (!value) {
        return { ok: false, error: 'Enter a barcode value.' };
    }
    if (value.length > MAX_LENGTH) {
        return { ok: false, error: `Use at most ${MAX_LENGTH} characters.` };
    }
    if (/[^\x20-\x7e]/.test(value)) {
        return { ok: false, error: 'Use only English letters, digits and common symbols.' };
    }

    let result;
    if (/^[0-9]{12}$/.test(value)) {
        value += eanCheckDigit(value);
    }
    if (isEan13(value)) {
        result = { type: 'EAN13', value, bits: encodeEan13(value) };
    } else if (/^[0-9]+$/.test(value) && value.length % 2 === 0) {
        result = { type: 'CODE128', set: 'C', value, bits: encodeCode128(code128Values(value, 'C'), START_C) };
    } else {
        result = { type: 'CODE128', set: 'B', value, bits: encodeCode128(code128Values(value, 'B'), START_B) };
    }

    const dots = PRINT_DOTS[paperWidth] || PRINT_DOTS[58];
    const moduleWidth = Math.min(MAX_MODULE, Math.floor(dots / (result.bits.length + QUIET_MODULES)));
    if (moduleWidth < MIN_MODULE) {
        const limit = paperWidth === 80 ? 21 : 12;
        return {
            ok: false,
            error: `Too long to print clearly on ${paperWidth} mm paper. Use up to ${limit} characters, or digits only (fits about twice as many).`
        };
    }
    return { ok: true, ...result, moduleWidth };
}

/** Merges runs of dark modules into rectangles for an SVG preview. */
export function svgBars(bits) {
    const bars = [];
    let i = 0;
    while (i < bits.length) {
        if (bits[i] === '1') {
            let j = i;
            while (j < bits.length && bits[j] === '1') {
                j++;
            }
            bars.push({ key: `b${i}`, x: i, width: j - i });
            i = j;
        } else {
            i++;
        }
    }
    return bars;
}
