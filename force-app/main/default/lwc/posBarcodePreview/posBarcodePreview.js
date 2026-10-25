import { LightningElement, api } from 'lwc';
import { encode, svgBars } from 'c/posBarcode';
import { money, num } from 'c/posUtils';

const PRINT_DOTS = { 58: 384, 80: 576 };
const QUIET = 10;

/** On-screen preview of one printed barcode label, drawn to scale for the paper width. */
export default class PosBarcodePreview extends LightningElement {
    @api value;
    @api paperWidth = 58;
    @api shop;
    @api line1;
    @api line2;
    @api price;
    @api mrp;

    get code() {
        return encode(this.value, Number(this.paperWidth));
    }

    get ok() {
        return this.code.ok;
    }

    get error() {
        return this.code.error;
    }

    get digits() {
        return this.code.value;
    }

    get bars() {
        return svgBars(this.code.bits);
    }

    get viewBox() {
        return `${-QUIET} 0 ${this.code.bits.length + QUIET * 2} 40`;
    }

    // Same physical width the printer will use, relative to the printable paper width.
    get svgStyle() {
        const c = this.code;
        const dots = PRINT_DOTS[Number(this.paperWidth)] || PRINT_DOTS[58];
        const pct = Math.min(100, ((c.bits.length + QUIET * 2) * c.moduleWidth * 100) / dots);
        return `width:${pct}%`;
    }

    get ariaLabel() {
        return `Barcode ${this.code.value}`;
    }

    get typeText() {
        const c = this.code;
        return c.type === 'EAN13' ? 'EAN-13' : 'Code 128';
    }

    get hasPrice() {
        return num(this.price) > 0;
    }

    get priceText() {
        return money(this.price);
    }

    get hasMrp() {
        return num(this.mrp) > num(this.price);
    }

    get mrpText() {
        return `MRP ${money(this.mrp)}`;
    }

    get paperClass() {
        return `paper${Number(this.paperWidth) === 80 ? ' paper_80' : ''}`;
    }
}
