import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { getBarcodeScanner } from 'lightning/mobileCapabilities';
import getBootstrap from '@salesforce/apex/PosController.getBootstrap';
import findCustomer from '@salesforce/apex/PosController.findCustomer';
import saveBill from '@salesforce/apex/PosController.saveBill';
import getCreditNote from '@salesforce/apex/PosReturnController.getCreditNote';
import {
    IS_DESKTOP,
    PAY_MODES,
    PAY_MODE_META,
    compareSizes,
    computeBill,
    errorMessage,
    initials,
    money,
    moneyShort,
    num,
    openUrl,
    round2,
    shareText,
    swatchStyle,
    whatsappUrl
} from 'c/posUtils';
import { loadSettings, printBill } from 'c/posPrint';
import { normalizeScan } from 'c/posBarcode';

const MAX_SUGGESTIONS = 8;
const PERCENT_PRESETS = [0, 5, 10, 15, 20];
const AMOUNT_PRESETS = [0, 50, 100, 200, 500];
const ALL = 'All';

export default class PosBilling extends NavigationMixin(LightningElement) {
    loading = true;
    loadError;
    store;
    products = [];
    productsById = new Map();
    productsByCode = new Map();
    styles = [];

    // search + browse
    searchTerm = '';
    suggestions = [];
    showBrowse = !IS_DESKTOP;
    category = ALL;
    selectedStyleKey;
    selectedColor;

    // cart
    cart = [];
    billDiscount = 0;
    showBillDiscount = false;
    editingLineId;
    calc = computeBill(null, [], 0);
    bump = false;

    // customer
    mobile = '';
    customer;
    customerName = '';
    lookingUp = false;

    // payment
    payments = [];
    splitMode = false;
    // While true, the single payment row follows the bill total as items change.
    autoPay = true;
    printSettings = loadSettings();
    printAfterSave = this.printSettings.autoPrint;
    // Bridge-app link from the last print, offered as a manual tap if the automatic hand-off is blocked.
    manualPrintUrl;
    saving = false;
    lastBill;

    // Credit note applied to this bill ({ no, bal }) — from an exchange or scanned/typed by the cashier.
    creditNote;
    exchangeNote;
    showNoteInput = false;
    noteDraft = '';
    applyingNote = false;

    // Return / exchange wizard shown in place of the billing screen.
    returnMode = false;
    returnQuery;

    // phone flow: 'cart' | 'checkout' (desktop shows both side by side)
    view = 'cart';
    scanner;
    canScan = false;
    isDesktop = IS_DESKTOP;

    connectedCallback() {
        this.load();
        this.scanner = getBarcodeScanner();
        this.canScan = Boolean(this.scanner && this.scanner.isAvailable());
        if (IS_DESKTOP) {
            this.keyHandler = (event) => this.handleShortcut(event);
            window.addEventListener('keydown', this.keyHandler);
        }
    }

    disconnectedCallback() {
        if (this.keyHandler) {
            window.removeEventListener('keydown', this.keyHandler);
        }
    }

    async load() {
        this.loading = true;
        try {
            const data = await getBootstrap();
            this.store = data.store;
            this.setProducts(data.products);
            this.loadError = undefined;
            this.recalc();
        } catch (error) {
            this.loadError = errorMessage(error);
        } finally {
            this.loading = false;
        }
    }

    /** Called by posApp when the Billing tab is shown again: pick up catalog/store edits, keep the open cart. */
    @api
    async refresh() {
        try {
            const data = await getBootstrap();
            this.store = data.store;
            this.setProducts(data.products);
            this.cart = this.cart
                .filter((l) => this.productsById.has(l.id))
                .map((l) => {
                    const p = this.productsById.get(l.id);
                    const listPrice = num(p.Price__c);
                    // Keep a price the cashier agreed with the customer; follow catalog changes otherwise.
                    const price = l.price === l.listPrice ? listPrice : l.price;
                    return { ...l, listPrice, price, stock: num(p.Stock__c) };
                });
            this.recalc();
        } catch (error) {
            // Keep working with the catalog already loaded.
        }
    }

    setProducts(products) {
        this.products = products;
        this.productsById = new Map(products.map((p) => [p.Id, p]));
        this.productsByCode = new Map();
        products.forEach((p) => {
            [p.Barcode__c, p.SKU__c].filter(Boolean).forEach((code) => this.productsByCode.set(code.toLowerCase(), p));
        });
        const byStyle = new Map();
        products.forEach((p) => {
            const key = `${p.Name}|${p.Brand__c || ''}`;
            let s = byStyle.get(key);
            if (!s) {
                s = { key, name: p.Name, brand: p.Brand__c, category: p.Category__c || 'Other', variants: [], min: Infinity, max: 0, stock: 0 };
                byStyle.set(key, s);
            }
            const price = num(p.Price__c);
            s.variants.push(p);
            s.min = Math.min(s.min, price);
            s.max = Math.max(s.max, price);
            s.stock += num(p.Stock__c);
        });
        this.styles = [...byStyle.values()];
    }

    // ---------- keyboard (desktop) ----------

    handleShortcut(event) {
        // Ignore while another POS tab is showing (this component stays mounted but hidden).
        if (!this.template.host || this.template.host.offsetParent === null) {
            return;
        }
        if (event.key === 'F2') {
            event.preventDefault();
            this.focusSearch();
        } else if (event.key === 'F9') {
            event.preventDefault();
            if (!this.saveDisabled) {
                this.handleSave();
            }
        }
    }

    // ---------- layout ----------

    get rootClass() {
        return `pos-billing${this.view === 'checkout' ? ' show-checkout' : ''}`;
    }

    get isCheckoutView() {
        return this.view === 'checkout';
    }

    get searchPlaceholder() {
        return this.canScan ? 'Search or tap scan' : 'Scan barcode or search name / SKU';
    }

    get emptyHint() {
        if (this.canScan) {
            return 'Tap the scan button, or browse products above.';
        }
        return IS_DESKTOP ? 'Scan a barcode, search, or browse. Press F2 to jump to search.' : 'Search or browse products above.';
    }

    handleCheckout() {
        this.view = 'checkout';
        this.reloadPrintSettings();
        this.scrollTop();
    }

    reloadPrintSettings() {
        this.printSettings = loadSettings();
        this.printAfterSave = this.printSettings.autoPrint;
    }

    handleBackToCart() {
        this.view = 'cart';
        this.scrollTop();
    }

    scrollTop() {
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            const top = this.template.querySelector('.pos-billing');
            if (top && top.scrollIntoView) {
                top.scrollIntoView({ block: 'start' });
            }
        }, 0);
    }

    focusSearch() {
        if (!IS_DESKTOP) {
            return; // focusing on phones pops the keyboard over the cart
        }
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            const input = this.template.querySelector('[data-id="search"]');
            if (input) {
                input.focus();
            }
        }, 0);
    }

    // ---------- search / scan ----------

    findMatches(term) {
        const t = (term || '').trim().toLowerCase();
        if (t.length < 2) {
            return [];
        }
        return this.products
            .filter((p) =>
                [p.Name, p.SKU__c, p.Barcode__c, p.Category__c, p.Brand__c, p.Color__c].some(
                    (v) => v && v.toLowerCase().includes(t)
                )
            )
            .slice(0, MAX_SUGGESTIONS)
            .map((p) => {
                const stock = num(p.Stock__c);
                return {
                    Id: p.Id,
                    Name: p.Name,
                    meta: [p.Size__c, p.Color__c, p.SKU__c].filter(Boolean).join(' · '),
                    priceText: money(p.Price__c),
                    stockText: stock > 0 ? `${stock} in stock` : 'Out of stock',
                    stockClass: stock > 0 ? 'meta' : 'warn',
                    swatch: swatchStyle(p.Color__c)
                };
            });
    }

    get hasSuggestions() {
        return this.suggestions.length > 0;
    }

    handleSearchChange(event) {
        this.searchTerm = event.target.value;
        this.suggestions = this.findMatches(this.searchTerm);
    }

    handleSearchKeyUp(event) {
        if (event.key === 'Escape') {
            this.suggestions = [];
            return;
        }
        if (event.key !== 'Enter') {
            return;
        }
        const term = (event.target.value || '').trim();
        if (!term) {
            return;
        }
        const exact = this.productsByCode.get(term.toLowerCase()) || this.productsByCode.get(normalizeScan(term).toLowerCase());
        const product = exact || (this.suggestions.length === 1 ? this.productsById.get(this.suggestions[0].Id) : null);
        if (product) {
            this.addProduct(product);
        } else if (this.routeDocumentCode(term)) {
            this.searchTerm = '';
            this.suggestions = [];
        } else if (!this.suggestions.length) {
            this.toast('Not found', `No product matches "${term}".`, 'warning');
        }
    }

    /**
     * Receipts and credit notes carry their number as a barcode. Scanning a credit note applies it;
     * scanning a bill opens the return wizard for it. Returns true when the code was handled.
     */
    routeDocumentCode(raw) {
        const code = normalizeScan(raw);
        if (/^CN-[0-9]+$/i.test(code)) {
            this.applyCreditNote(code);
            return true;
        }
        const prefix = (this.store && this.store.Bill_Prefix__c) || '';
        if (prefix && code.toUpperCase().startsWith(prefix.toUpperCase()) && /^[0-9]+$/.test(code.slice(prefix.length))) {
            this.startReturn(code);
            return true;
        }
        return false;
    }

    handleSuggestionClick(event) {
        const product = this.productsById.get(event.currentTarget.dataset.id);
        if (product) {
            this.addProduct(product);
        }
    }

    async handleScan() {
        const scanner = this.scanner;
        const t = scanner.barcodeTypes;
        try {
            const result = await scanner.beginCapture({
                barcodeTypes: [t.EAN_13, t.EAN_8, t.UPC_A, t.UPC_E, t.CODE_128, t.CODE_39, t.QR],
                instructionText: 'Point the camera at the product barcode',
                successText: 'Scanned'
            });
            const scanned = (result && result.value ? result.value : '').trim();
            const code = normalizeScan(scanned);
            const product = this.productsByCode.get(scanned.toLowerCase()) || this.productsByCode.get(code.toLowerCase());
            if (product) {
                this.addProduct(product);
                this.toast('Added', `${product.Name} ${[product.Size__c, product.Color__c].filter(Boolean).join(' / ')}`, 'success');
            } else if (this.routeDocumentCode(code)) {
                // credit note applied or return opened
            } else {
                this.toast('Not found', `No product has barcode ${code}.`, 'warning');
            }
        } catch (error) {
            const code = error && error.code;
            if (code !== 'userDismissedScanner' && code !== 'USER_DISMISSED') {
                this.toast('Scan failed', errorMessage(error), 'error');
            }
        } finally {
            scanner.endCapture();
        }
    }

    // ---------- browse (category → style → color/size) ----------

    get browseBtnClass() {
        return `icon-btn${this.showBrowse ? ' icon-btn_brand' : ''}`;
    }

    get browsePressed() {
        return String(this.showBrowse);
    }

    toggleBrowse() {
        this.showBrowse = !this.showBrowse;
    }

    get categoryChips() {
        const cats = [...new Set(this.styles.map((s) => s.category))].sort();
        return [ALL, ...cats].map((name) => ({
            name,
            cls: `chip${name === this.category ? ' chip_selected' : ''}`,
            pressed: String(name === this.category)
        }));
    }

    get styleTiles() {
        return this.styles
            .filter((s) => this.category === ALL || s.category === this.category)
            .map((s) => {
                const colors = [...new Set(s.variants.map((v) => v.Color__c).filter(Boolean))];
                return {
                    key: s.key,
                    name: s.name,
                    brand: s.brand || s.category,
                    priceText: s.min === s.max ? moneyShort(s.min) : `${moneyShort(s.min)}+`,
                    stockText: s.stock > 0 ? `${s.stock} pcs` : 'Out of stock',
                    swatches: colors.slice(0, 6).map((c) => ({ name: c, style: swatchStyle(c) })),
                    cls: `tile${s.stock > 0 ? '' : ' tile_out'}`
                };
            });
    }

    get hasStyles() {
        return this.styles.length > 0;
    }

    get selectedStyle() {
        return this.styles.find((s) => s.key === this.selectedStyleKey);
    }

    get selectedStyleMeta() {
        const s = this.selectedStyle;
        if (!s) {
            return '';
        }
        const price = s.min === s.max ? money(s.min) : `${money(s.min)} – ${money(s.max)}`;
        return [s.brand, price].filter(Boolean).join(' · ');
    }

    get colorChips() {
        const s = this.selectedStyle;
        if (!s) {
            return [];
        }
        return [...new Set(s.variants.map((v) => v.Color__c || '—'))].map((name) => ({
            name,
            swatch: swatchStyle(name),
            cls: `chip${name === this.selectedColor ? ' chip_selected' : ''}`,
            pressed: String(name === this.selectedColor)
        }));
    }

    get hasColorChoice() {
        return this.colorChips.length > 1;
    }

    get sizeButtons() {
        const s = this.selectedStyle;
        if (!s) {
            return [];
        }
        const inCart = new Map(this.cart.map((l) => [l.id, l.q]));
        return s.variants
            .filter((v) => (v.Color__c || '—') === this.selectedColor)
            .sort((a, b) => compareSizes(a.Size__c || '', b.Size__c || ''))
            .map((v) => {
                const stock = num(v.Stock__c);
                return {
                    id: v.Id,
                    size: v.Size__c || 'One size',
                    stockText: stock > 0 ? `${stock} left` : 'None left',
                    inCart: inCart.get(v.Id) || 0,
                    cls: `size-btn${stock > 0 ? '' : ' size-btn_out'}${inCart.has(v.Id) ? ' size-btn_in' : ''}`
                };
            });
    }

    handleCategory(event) {
        this.category = event.currentTarget.dataset.name;
    }

    handleStyleSelect(event) {
        this.selectedStyleKey = event.currentTarget.dataset.key;
        const s = this.selectedStyle;
        const firstInStock = s.variants.find((v) => num(v.Stock__c) > 0) || s.variants[0];
        this.selectedColor = firstInStock.Color__c || '—';
    }

    handleColorSelect(event) {
        this.selectedColor = event.currentTarget.dataset.name;
    }

    handleSizeAdd(event) {
        const product = this.productsById.get(event.currentTarget.dataset.id);
        if (product) {
            this.addProduct(product);
        }
    }

    handleBrowseBack() {
        this.selectedStyleKey = undefined;
    }

    // ---------- cart ----------

    addProduct(p) {
        if (this.cart.some((l) => l.id === p.Id)) {
            this.cart = this.cart.map((l) => (l.id === p.Id ? { ...l, q: l.q + 1 } : l));
        } else {
            this.cart = [
                ...this.cart,
                {
                    id: p.Id,
                    name: p.Name,
                    meta: [p.Size__c, p.Color__c, p.SKU__c].filter(Boolean).join(' · '),
                    swatch: swatchStyle(p.Color__c),
                    listPrice: num(p.Price__c),
                    price: num(p.Price__c),
                    stock: num(p.Stock__c),
                    q: 1,
                    discMode: 'pct', // 'pct' | 'amt'; only one discount type applies per line
                    dp: 0,
                    da: 0
                }
            ];
        }
        this.searchTerm = '';
        this.suggestions = [];
        this.lastBill = undefined;
        this.manualPrintUrl = undefined;
        this.recalc();
        this.pulse();
        this.focusSearch();
    }

    pulse() {
        this.bump = false;
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            this.bump = true;
        }, 0);
    }

    get hasCart() {
        return this.cart.length > 0;
    }

    get rows() {
        return this.calc.lines.map((l) => {
            const editing = this.editingLineId === l.id;
            return {
                ...l,
                priceText: money(l.price),
                netText: money(l.net),
                grossText: money(l.gross),
                hasDiscount: l.net < l.gross,
                stockWarning: l.q > l.stock ? (l.stock > 0 ? `Only ${l.stock} in stock` : 'Out of stock') : null,
                decIcon: l.q > 1 ? 'utility:dash' : 'utility:delete',
                decLabel: l.q > 1 ? 'Decrease quantity' : 'Remove item',
                editing,
                expanded: String(editing),
                ...this.lineEditorProps(l)
            };
        });
    }

    lineEditorProps(l) {
        const isAmount = l.discMode === 'amt';
        const current = isAmount ? num(l.da) : num(l.dp);
        const priceEdited = l.price !== l.listPrice;
        let discountLabel = 'Discount';
        if (num(l.da) > 0) {
            discountLabel = `${moneyShort(l.da)} off`;
        } else if (num(l.dp) > 0) {
            discountLabel = `${l.dp}% off`;
        }
        return {
            discountLabel,
            discountBtnClass: `chip${num(l.dp) > 0 || num(l.da) > 0 ? ' chip_selected' : ''}`,
            priceChipLabel: `${moneyShort(l.price)} each`,
            priceBtnClass: `chip${priceEdited ? ' chip_edited' : ''}`,
            priceEdited,
            listPriceText: `Usual price ${money(l.listPrice)}`,
            isAmount,
            pctModeClass: `seg-btn${isAmount ? '' : ' seg-btn_on'}`,
            amtModeClass: `seg-btn${isAmount ? ' seg-btn_on' : ''}`,
            pctPressed: String(!isAmount),
            amtPressed: String(isAmount),
            discountValue: current || '',
            discountInputLabel: isAmount ? 'Discount on this item (₹)' : 'Discount on this item (%)',
            discountMax: isAmount ? l.gross : 100,
            discountStep: isAmount ? 1 : 0.01,
            presets: (isAmount ? AMOUNT_PRESETS : PERCENT_PRESETS).map((value) => ({
                value,
                label: value ? (isAmount ? moneyShort(value) : `${value}%`) : 'None',
                cls: `chip${current === value ? ' chip_selected' : ''}`
            }))
        };
    }

    updateLine(id, changes) {
        this.cart = this.cart.map((l) => (l.id === id ? { ...l, ...changes } : l));
        this.recalc();
    }

    removeLine(id) {
        this.cart = this.cart.filter((l) => l.id !== id);
        if (this.editingLineId === id) {
            this.editingLineId = undefined;
        }
        this.recalc();
    }

    handleDec(event) {
        const id = event.currentTarget.dataset.id;
        const line = this.cart.find((l) => l.id === id);
        if (line && line.q > 1) {
            this.updateLine(id, { q: line.q - 1 });
        } else {
            this.removeLine(id);
        }
    }

    handleInc(event) {
        const id = event.currentTarget.dataset.id;
        const line = this.cart.find((l) => l.id === id);
        if (line) {
            this.updateLine(id, { q: line.q + 1 });
        }
    }

    handleQtyInput(event) {
        const q = Math.max(1, Math.floor(num(event.target.value, 1)));
        event.target.value = q;
        this.updateLine(event.target.dataset.id, { q });
    }

    handleToggleDiscount(event) {
        const id = event.currentTarget.dataset.id;
        this.editingLineId = this.editingLineId === id ? undefined : id;
    }

    // Sets the line discount in the line's current mode and clears the other type.
    setLineDiscount(id, value) {
        const line = this.cart.find((l) => l.id === id);
        if (!line) {
            return;
        }
        if (line.discMode === 'amt') {
            const gross = round2(line.price * line.q);
            this.updateLine(id, { da: Math.min(gross, Math.max(0, round2(num(value)))), dp: 0 });
        } else {
            this.updateLine(id, { dp: Math.min(100, Math.max(0, num(value))), da: 0 });
        }
    }

    handleDiscountMode(event) {
        const { id, mode } = event.currentTarget.dataset;
        const line = this.cart.find((l) => l.id === id);
        if (line && line.discMode !== mode) {
            this.updateLine(id, { discMode: mode, dp: 0, da: 0 });
        }
    }

    handlePresetDiscount(event) {
        const { id, value } = event.currentTarget.dataset;
        this.setLineDiscount(id, value);
    }

    handleDiscountChange(event) {
        const value = event.detail.value;
        this.setLineDiscount(event.target.dataset.id, value === '' || value === null ? 0 : value);
    }

    handlePriceChange(event) {
        const value = num(event.detail.value, 0);
        if (value <= 0) {
            return; // keep the last valid price while the field is being retyped
        }
        this.updateLine(event.target.dataset.id, { price: round2(value) });
    }

    handleResetPrice(event) {
        const id = event.currentTarget.dataset.id;
        const line = this.cart.find((l) => l.id === id);
        if (line) {
            this.updateLine(id, { price: line.listPrice });
        }
    }

    handleCloseEditor() {
        this.editingLineId = undefined;
    }

    handleShowBillDiscount() {
        this.showBillDiscount = true;
    }

    handleBillDiscountChange(event) {
        this.billDiscount = Math.max(0, num(event.detail.value));
        this.recalc();
    }

    recalc() {
        this.calc = computeBill(this.store, this.cart, this.billDiscount);
        if (!this.splitMode && this.cart.length && !this.payments.length) {
            this.payments = [{ key: 'p-default', m: 'CASH', a: this.payable }];
            this.autoPay = true;
        } else if (this.autoPay && this.payments.length === 1) {
            this.payments = [{ ...this.payments[0], a: this.payable }];
        }
    }

    get itemCount() {
        return this.calc.items;
    }
    get itemCountText() {
        const n = this.calc.items;
        return `${n} item${n === 1 ? '' : 's'}`;
    }
    get grossText() {
        return money(this.calc.sub);
    }
    get discountText() {
        return money(this.calc.dis);
    }
    get taxText() {
        return money(this.calc.tax);
    }
    get roundOffText() {
        return money(this.calc.ro);
    }
    get grandText() {
        return money(this.calc.g);
    }
    get hasDiscount() {
        return this.calc.dis > 0;
    }
    get hasRoundOff() {
        return this.calc.ro !== 0;
    }
    get billDiscountOpen() {
        return this.showBillDiscount || this.billDiscount > 0;
    }
    get barClass() {
        return `bar-summary${this.bump ? ' bump' : ''}`;
    }
    get checkoutDisabled() {
        return !this.hasCart;
    }

    // ---------- customer ----------

    async handleMobileChange(event) {
        const value = (event.detail.value || '').replace(/\D/g, '').slice(0, 10);
        this.mobile = value;
        this.customer = undefined;
        if (value.length !== 10) {
            return;
        }
        this.lookingUp = true;
        try {
            const found = await findCustomer({ mobile: value });
            if (this.mobile !== value) {
                return;
            }
            this.customer = found || undefined;
            this.customerName = found && found.n ? found.n : this.customerName;
        } catch (error) {
            this.toast('Customer lookup failed', errorMessage(error), 'error');
        } finally {
            this.lookingUp = false;
        }
    }

    handleCustomerNameChange(event) {
        this.customerName = event.detail.value;
    }

    handleClearCustomer() {
        this.mobile = '';
        this.customer = undefined;
        this.customerName = '';
    }

    get hasMobile() {
        return this.mobile.length === 10;
    }

    get isNewCustomer() {
        return this.hasMobile && !this.lookingUp && !this.customer;
    }

    get customerDisplayName() {
        return (this.customer && this.customer.n) || 'Customer';
    }

    get customerInitials() {
        return initials(this.customer && this.customer.n);
    }

    get customerSummary() {
        const c = this.customer;
        if (!c) {
            return '';
        }
        return `${num(c.v)} visits · ${moneyShort(c.s)} · ${num(c.pt)} pts`;
    }

    get customerHasDue() {
        return Boolean(this.customer) && num(this.customer.du) > 0;
    }

    get customerDueText() {
        return this.customer ? money(this.customer.du) : '';
    }

    get customerNeedsName() {
        return Boolean(this.customer) && !this.customer.n;
    }

    // ---------- payment ----------

    get singleMode() {
        return !this.splitMode && this.payments.length === 1 ? this.payments[0].m : null;
    }

    get payTiles() {
        const selected = this.singleMode;
        return PAY_MODES.map((m) => ({
            mode: m,
            label: PAY_MODE_META[m].label,
            icon: PAY_MODE_META[m].icon,
            cls: `pay-tile${selected === m ? ' pay-tile_selected' : ''}`,
            pressed: String(selected === m)
        }));
    }

    get isCashSingle() {
        return this.singleMode === 'CASH' && this.payable > 0;
    }

    get cashReceived() {
        return this.isCashSingle ? this.payments[0].a : 0;
    }

    get tenderChips() {
        const g = this.payable;
        const current = num(this.cashReceived);
        const amounts = [...new Set([g, Math.ceil(g / 100) * 100, Math.ceil(g / 500) * 500, Math.ceil(g / 2000) * 2000])]
            .filter((a) => a >= g)
            .sort((a, b) => a - b)
            .slice(0, 4);
        return amounts.map((a) => ({
            value: a,
            label: a === g ? 'Exact' : moneyShort(a),
            cls: `chip${current === a ? ' chip_selected' : ''}`
        }));
    }

    get splitLabel() {
        return this.splitMode ? 'Single payment' : 'Split payment';
    }

    get payModeOptions() {
        return PAY_MODES.map((m) => ({ label: PAY_MODE_META[m].label, value: m }));
    }

    get paymentRows() {
        return this.payments;
    }

    get hasPayments() {
        return this.payments.some((p) => num(p.a) > 0) || (this.cnApplied > 0 && this.payable === 0);
    }

    get paid() {
        return round2(this.payments.reduce((t, p) => t + num(p.a), 0));
    }

    get hasCredit() {
        return this.payments.some((p) => p.m === 'CREDIT' && num(p.a) > 0);
    }

    get balanceDiff() {
        return round2(this.paid - this.payable);
    }

    get balanceText() {
        const diff = this.balanceDiff;
        if (!this.hasCart) {
            return '';
        }
        if (!this.hasPayments) {
            return 'Choose how the customer pays';
        }
        if (diff < 0) {
            return `Still to collect ${money(-diff)}`;
        }
        if (diff > 0) {
            return `Return change ${money(diff)}`;
        }
        return 'Fully paid';
    }

    get balanceClass() {
        if (!this.hasCart) {
            return 'balance';
        }
        if (this.balanceDiff < 0 || !this.hasPayments) {
            return 'balance balance_due';
        }
        return this.balanceDiff > 0 ? 'balance balance_change' : 'balance balance_ok';
    }

    get paymentProblem() {
        if (this.hasCredit && !this.hasMobile) {
            return 'Add the customer mobile number for a credit sale.';
        }
        if (this.balanceDiff > 0 && !this.payments.some((p) => p.m === 'CASH')) {
            return 'Only cash can be more than the bill total.';
        }
        if (this.balanceDiff > 0 && this.hasCredit) {
            return 'Credit cannot be combined with returning change.';
        }
        return null;
    }

    handlePayMode(event) {
        const mode = event.currentTarget.dataset.mode;
        this.payments = [{ key: `p-${mode}`, m: mode, a: this.payable }];
        this.autoPay = true;
    }

    handleTender(event) {
        const value = num(event.currentTarget.dataset.value);
        this.payments = [{ ...this.payments[0], a: value }];
        this.autoPay = value === this.payable;
    }

    handleCashReceived(event) {
        const value = num(event.detail.value);
        this.payments = [{ ...this.payments[0], a: value }];
        this.autoPay = false;
    }

    toggleSplit() {
        if (this.splitMode) {
            this.splitMode = false;
            this.payments = [{ key: 'p-CASH', m: 'CASH', a: this.payable }];
            this.autoPay = true;
        } else {
            this.splitMode = true;
            this.autoPay = false;
            const first = this.payments[0] || { key: 'p-CASH', m: 'CASH', a: this.payable };
            this.payments = [{ ...first, key: `p-${Date.now()}` }];
        }
    }

    handleAddPayment() {
        const remaining = Math.max(0, round2(this.payable - this.paid));
        const used = new Set(this.payments.map((p) => p.m));
        const mode = PAY_MODES.find((m) => !used.has(m)) || 'UPI';
        this.payments = [...this.payments, { key: `p-${Date.now()}`, m: mode, a: remaining }];
    }

    handlePayModeChange(event) {
        const key = event.target.dataset.key;
        this.payments = this.payments.map((p) => (p.key === key ? { ...p, m: event.detail.value } : p));
    }

    handlePayAmountChange(event) {
        const key = event.target.dataset.key;
        this.payments = this.payments.map((p) => (p.key === key ? { ...p, a: num(event.detail.value) } : p));
    }

    handleRemovePayment(event) {
        const key = event.currentTarget.dataset.key;
        this.payments = this.payments.filter((p) => p.key !== key);
    }

    get canRemovePayment() {
        return this.payments.length > 1;
    }

    handlePrintToggle(event) {
        this.printAfterSave = event.target.checked;
    }

    get saveDisabled() {
        return (
            this.saving ||
            this.lookingUp ||
            !this.hasCart ||
            !this.hasPayments ||
            this.balanceDiff < 0 ||
            Boolean(this.paymentProblem)
        );
    }

    get saveLabel() {
        return this.saving ? 'Saving…' : `Save bill · ${this.barTotalText}`;
    }

    // With a credit note applied, what matters at the counter is what is left to pay.
    get barTotalText() {
        return this.cnApplied > 0 ? this.payableText : this.grandText;
    }

    // ---------- credit notes ----------

    get cnApplied() {
        return this.creditNote ? Math.min(num(this.creditNote.bal), this.calc.g) : 0;
    }

    get payable() {
        return round2(Math.max(0, this.calc.g - this.cnApplied));
    }

    get payableText() {
        return money(this.payable);
    }

    get cnAppliedText() {
        return `−${money(this.cnApplied)}`;
    }

    get cnLeftText() {
        const left = this.creditNote ? round2(num(this.creditNote.bal) - this.cnApplied) : 0;
        return left > 0 ? `${money(left)} stays on the note for later` : '';
    }

    get hasCreditNote() {
        return Boolean(this.creditNote);
    }

    get noteApplyDisabled() {
        return this.applyingNote || !this.noteDraft.trim();
    }

    handleShowNoteInput() {
        this.showNoteInput = true;
    }

    handleNoteDraft(event) {
        this.noteDraft = event.detail.value || '';
    }

    handleNoteKey(event) {
        if (event.key === 'Enter') {
            this.noteDraft = event.target.value || '';
            this.applyCreditNote(this.noteDraft);
        }
    }

    handleApplyNote() {
        this.applyCreditNote(this.noteDraft);
    }

    async applyCreditNote(raw) {
        const no = normalizeScan(raw).toUpperCase();
        if (!no) {
            return;
        }
        this.applyingNote = true;
        try {
            const note = await getCreditNote({ noteNo: no });
            this.creditNote = { no: note.no, bal: num(note.bal) };
            this.showNoteInput = false;
            this.noteDraft = '';
            if (!this.hasMobile && note.cu && note.cu.m) {
                this.setCustomerMobile(note.cu.m);
            }
            this.recalc();
            this.toast('Credit note applied', `${note.no} · ${money(note.bal)} available`, 'success');
        } catch (e) {
            this.toast('Credit note not applied', errorMessage(e), 'error');
        } finally {
            this.applyingNote = false;
        }
    }

    handleRemoveNote() {
        this.creditNote = undefined;
        this.exchangeNote = undefined;
        this.recalc();
    }

    async setCustomerMobile(mobile) {
        await this.handleMobileChange({ detail: { value: mobile } });
    }

    // ---------- returns / exchanges ----------

    /** Opens the return wizard, optionally searching right away (bill no or mobile). */
    @api
    startReturn(query) {
        this.returnQuery = query || '';
        this.returnMode = true;
        this.scrollTop();
    }

    handleOpenReturn() {
        this.startReturn('');
    }

    handleReturnClose() {
        this.returnMode = false;
        this.returnQuery = undefined;
        this.refresh();
        this.focusSearch();
    }

    async handleExchange(event) {
        const note = event.detail.note;
        this.returnMode = false;
        this.returnQuery = undefined;
        this.resetBill();
        this.lastBill = undefined;
        this.creditNote = { no: note.no, bal: num(note.bal) };
        this.exchangeNote = note;
        this.recalc();
        await this.refresh();
        if (note.cu && note.cu.m) {
            this.setCustomerMobile(note.cu.m);
        }
        this.toast('Return saved', `${note.no} · ${money(note.bal)} credit applied. Now add the new items.`, 'success');
    }

    get exchangeText() {
        const n = this.exchangeNote;
        return n ? `Exchange for ${n.ref}: ${money(n.bal)} credit from ${n.no}. Scan the new items.` : '';
    }

    // ---------- save ----------

    async handleSave() {
        const payload = {
            mobile: this.hasMobile ? this.mobile : null,
            customerName: this.customerName,
            billDiscount: num(this.billDiscount),
            lines: this.cart.map((l) => ({
                id: l.id,
                q: l.q,
                dp: l.discMode === 'amt' ? 0 : l.dp,
                da: l.discMode === 'amt' ? l.da : 0,
                price: l.price
            })),
            payments: [
                ...(this.cnApplied > 0 ? [{ m: 'CN', a: this.cnApplied, ref: this.creditNote.no }] : []),
                ...this.payments.filter((p) => num(p.a) > 0).map((p) => ({ m: p.m, a: num(p.a) }))
            ]
        };
        this.saving = true;
        try {
            const bill = await saveBill({ billJson: JSON.stringify(payload) });
            const sold = new Map(this.cart.map((l) => [l.id, l.q]));
            this.setProducts(
                this.products.map((p) => (sold.has(p.Id) ? { ...p, Stock__c: num(p.Stock__c) - sold.get(p.Id) } : p))
            );
            this.lastBill = bill;
            if (this.printAfterSave) {
                this.openReceipt(bill);
            }
            this.resetBill();
        } catch (error) {
            this.toast('Could not save bill', errorMessage(error), 'error');
        } finally {
            this.saving = false;
        }
    }

    openReceipt(bill) {
        this.printSettings = loadSettings();
        const result = printBill(this, bill, this.store, this.printSettings);
        this.manualPrintUrl = result.url;
        if (result.error) {
            this.toast('Printer not set up', result.error, 'warning');
        }
    }

    get printLabel() {
        return this.printSettings.method === 'bluetooth'
            ? 'Print on Bluetooth printer after saving'
            : 'Open receipt after saving';
    }

    handlePrintLast() {
        if (this.lastBill) {
            this.openReceipt(this.lastBill);
        }
    }

    handleShareLast() {
        const b = this.lastBill;
        if (b) {
            openUrl(this, whatsappUrl(b.cu ? b.cu.m : null, shareText(b, this.store && this.store.Name)));
        }
    }

    handleDismissLast() {
        this.lastBill = undefined;
        this.manualPrintUrl = undefined;
    }

    get lastBillSub() {
        const b = this.lastBill;
        if (!b) {
            return '';
        }
        const parts = [money(b.g)];
        if (num(b.chg) > 0) {
            parts.push(`return change ${money(b.chg)}`);
        }
        if (b.cu && b.cu.n) {
            parts.push(b.cu.n);
        }
        return parts.join(' · ');
    }

    handleClear() {
        this.resetBill();
        this.lastBill = undefined;
    }

    resetBill() {
        this.cart = [];
        this.billDiscount = 0;
        this.showBillDiscount = false;
        this.editingLineId = undefined;
        this.mobile = '';
        this.customer = undefined;
        this.customerName = '';
        this.payments = [];
        this.splitMode = false;
        this.autoPay = true;
        this.creditNote = undefined;
        this.exchangeNote = undefined;
        this.showNoteInput = false;
        this.noteDraft = '';
        this.searchTerm = '';
        this.suggestions = [];
        this.selectedStyleKey = undefined;
        this.view = 'cart';
        this.reloadPrintSettings();
        this.recalc();
        this.focusSearch();
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
