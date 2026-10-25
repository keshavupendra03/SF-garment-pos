import { LightningElement } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getStoreInfo from '@salesforce/apex/PosController.getStoreInfo';
import { encode, randomEan13 } from 'c/posBarcode';
import { buildBarcodeLabels, loadSettings, printBytes } from 'c/posPrint';
import { num } from 'c/posUtils';

const MAX_COPIES = 200;
const COPY_PRESETS = [1, 5, 10, 20, 50];

/** Print any value as a barcode label: free text or a generated code, with optional text and price. */
export default class PosBarcodeTool extends NavigationMixin(LightningElement) {
    value = '';
    line1 = '';
    line2 = '';
    price = null;
    copies = 1;
    showShop = true;
    store;
    settings = loadSettings();
    manualUrl;
    touched = false;

    connectedCallback() {
        getStoreInfo()
            .then((store) => {
                this.store = store;
            })
            .catch(() => {
                this.store = undefined;
            });
    }

    get paperWidth() {
        return Number(this.settings.width) === 80 ? 80 : 58;
    }

    get code() {
        return encode(this.value, this.paperWidth);
    }

    get shopName() {
        return this.showShop && this.store ? this.store.Name : null;
    }

    get showError() {
        return this.touched && !this.code.ok;
    }

    get errorText() {
        return this.code.error;
    }

    get hasValue() {
        return Boolean((this.value || '').trim());
    }

    get copyChips() {
        return COPY_PRESETS.map((n) => ({
            value: n,
            label: String(n),
            cls: `chip${this.copies === n ? ' chip_selected' : ''}`
        }));
    }

    get printLabel() {
        return `Print ${this.copies} label${this.copies === 1 ? '' : 's'}`;
    }

    get printDisabled() {
        return !this.code.ok || this.copies < 1;
    }

    get needsBluetooth() {
        return this.settings.method !== 'bluetooth';
    }

    get valueHint() {
        const c = this.code;
        if (!this.hasValue) {
            return 'Type your own code (letters or digits) or generate a new one.';
        }
        if (!c.ok) {
            return '';
        }
        return c.type === 'EAN13'
            ? 'Prints as EAN-13, the standard retail barcode.'
            : 'Prints as Code 128. Any scanner set to read Code 128 will read it.';
    }

    handleValue(event) {
        this.value = event.detail.value;
        this.touched = true;
        this.manualUrl = undefined;
    }

    handleGenerate() {
        this.value = randomEan13();
        this.touched = true;
        this.manualUrl = undefined;
    }

    handleLine1(event) {
        this.line1 = event.detail.value;
    }

    handleLine2(event) {
        this.line2 = event.detail.value;
    }

    handlePrice(event) {
        const v = event.detail.value;
        this.price = v === '' || v === null ? null : num(v);
    }

    handleShowShop(event) {
        this.showShop = event.target.checked;
    }

    setCopies(n) {
        this.copies = Math.min(MAX_COPIES, Math.max(1, Math.floor(num(n, 1))));
    }

    handleCopyChip(event) {
        this.setCopies(event.currentTarget.dataset.value);
    }

    handleCopyStep(event) {
        this.setCopies(this.copies + Number(event.currentTarget.dataset.delta));
    }

    handleCopiesInput(event) {
        this.setCopies(event.target.value);
        event.target.value = this.copies;
    }

    handleBack() {
        this.dispatchEvent(new CustomEvent('close'));
    }

    handlePrint() {
        this.touched = true;
        if (this.printDisabled) {
            return;
        }
        this.settings = loadSettings();
        const bytes = buildBarcodeLabels(
            [{ code: this.code, copies: this.copies, title: this.line1.trim(), subtitle: this.line2.trim(), price: this.price }],
            { shop: this.shopName, width: this.paperWidth, mode: this.settings.barcodeMode, feed: this.settings.tearFeed }
        );
        const result = printBytes(this, bytes, { ...this.settings, method: 'bluetooth' });
        if (result.error) {
            this.dispatchEvent(new ShowToastEvent({ title: 'Printer not set up', message: result.error, variant: 'warning' }));
            return;
        }
        this.manualUrl = result.url;
    }
}
