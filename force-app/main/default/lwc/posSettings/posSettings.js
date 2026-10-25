import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getStoreInfo from '@salesforce/apex/PosController.getStoreInfo';
import { TEAR_FEEDS, buildTestPage, columnsFor, loadSettings, platform, printBytes, saveSettings } from 'c/posPrint';

const METHODS = [
    { name: 'bluetooth', label: 'Bluetooth printer', icon: 'utility:print', hint: 'Thermal printer through a bridge app' },
    { name: 'page', label: 'Receipt page', icon: 'utility:page', hint: 'Browser print / PDF' }
];

const PLATFORM_LABELS = {
    android: 'Android phone',
    ios: 'iPhone / iPad',
    desktop: 'Computer',
    other: 'This device'
};

export default class PosSettings extends NavigationMixin(LightningElement) {
    settings = loadSettings();
    device = platform();
    store;
    manualUrl;

    connectedCallback() {
        getStoreInfo()
            .then((store) => {
                this.store = store;
            })
            .catch(() => {
                this.store = undefined;
            });
    }

    @api
    refresh() {
        ['c-pos-store-settings', 'c-pos-storage'].forEach((selector) => {
            const child = this.template.querySelector(selector);
            if (child) {
                child.refresh();
            }
        });
        getStoreInfo()
            .then((store) => {
                this.store = store;
            })
            .catch(() => {});
    }

    update(changes) {
        this.settings = { ...this.settings, ...changes };
        saveSettings(this.settings);
    }

    get deviceLabel() {
        return PLATFORM_LABELS[this.device];
    }

    get isAndroid() {
        return this.device === 'android';
    }

    get isIos() {
        return this.device === 'ios';
    }

    get isBluetooth() {
        return this.settings.method === 'bluetooth';
    }

    get methodTiles() {
        return METHODS.map((m) => ({
            ...m,
            cls: `method${m.name === this.settings.method ? ' method_selected' : ''}`,
            pressed: String(m.name === this.settings.method)
        }));
    }

    get widthChips() {
        return [58, 80].map((w) => ({
            value: w,
            label: `${w} mm · ${columnsFor(w)} chars`,
            cls: `chip${Number(this.settings.width) === w ? ' chip_selected' : ''}`,
            pressed: String(Number(this.settings.width) === w)
        }));
    }

    get barcodeModeChips() {
        const current = this.settings.barcodeMode;
        return [
            { value: 'image', label: 'Standard (printed as image)' },
            { value: 'codeset', label: "Printer's barcode command" }
        ].map((m) => ({
            ...m,
            cls: `chip${m.value === current ? ' chip_selected' : ''}`,
            pressed: String(m.value === current)
        }));
    }

    get feedChips() {
        const current = Number(this.settings.tearFeed);
        return TEAR_FEEDS.map((f) => ({
            value: f.dots,
            label: `${f.label} · ${Math.round(f.dots / 8)} mm`,
            cls: `chip${f.dots === current ? ' chip_selected' : ''}`,
            pressed: String(f.dots === current)
        }));
    }

    handleFeed(event) {
        this.update({ tearFeed: Number(event.currentTarget.dataset.value) });
    }

    handleBarcodeMode(event) {
        this.update({ barcodeMode: event.currentTarget.dataset.value });
    }

    get bluetoothOnDesktop() {
        return this.isBluetooth && !this.isAndroid && !this.isIos;
    }

    handleMethod(event) {
        this.update({ method: event.currentTarget.dataset.name });
        this.manualUrl = undefined;
    }

    handleWidth(event) {
        this.update({ width: Number(event.currentTarget.dataset.value) });
    }

    handleAutoPrint(event) {
        this.update({ autoPrint: event.target.checked });
    }

    handleIosTemplate(event) {
        this.update({ iosTemplate: event.detail.value });
    }

    handleTestPrint() {
        const result = printBytes(this, buildTestPage(this.store, this.settings.width, this.settings.tearFeed), this.settings);
        if (result.error) {
            this.dispatchEvent(new ShowToastEvent({ title: 'Printer not set up', message: result.error, variant: 'warning' }));
            return;
        }
        this.manualUrl = result.url;
    }
}
