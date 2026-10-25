import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getProducts from '@salesforce/apex/PosAdminController.getProducts';
import saveStyle from '@salesforce/apex/PosAdminController.saveStyle';
import adjustStock from '@salesforce/apex/PosAdminController.adjustStock';
import setActive from '@salesforce/apex/PosAdminController.setActive';
import assignBarcodes from '@salesforce/apex/PosAdminController.assignBarcodes';
import setBarcode from '@salesforce/apex/PosAdminController.setBarcode';
import getStoreInfo from '@salesforce/apex/PosController.getStoreInfo';
import { compareSizes, errorMessage, money, moneyShort, num, swatchStyle } from 'c/posUtils';
import { buildLabels, loadSettings, printBytes } from 'c/posPrint';

const LOW_STOCK = 3;
const ALL = 'All';
const STOCK_COMMIT_DELAY = 700;

const STOCK_FILTERS = [
    { name: 'all', label: 'All' },
    { name: 'low', label: 'Low stock' },
    { name: 'out', label: 'Out of stock' },
    { name: 'inactive', label: 'Inactive' }
];

const SIZE_PRESETS = [
    { name: 'Tops', sizes: ['S', 'M', 'L', 'XL', 'XXL'] },
    { name: 'Waist', sizes: ['28', '30', '32', '34', '36', '38'] },
    { name: 'Shirts', sizes: ['38', '40', '42', '44'] },
    { name: 'Kids', sizes: ['2-3Y', '4-5Y', '6-7Y', '8-9Y', '10-11Y'] },
    { name: 'Free size', sizes: ['Free'] }
];

const QUICK_COLORS = ['Black', 'White', 'Navy', 'Grey', 'Blue', 'Red', 'Green', 'Maroon', 'Beige', 'Pink', 'Yellow'];

const keyOf = (name, brand) => `${name}|${brand || ''}`;
const cellKey = (color, size) => `${color}|${size}`;

function variantLabel(p) {
    return [p.Color__c, p.Size__c].filter(Boolean).join(' / ') || 'Standard';
}

export default class PosProducts extends NavigationMixin(LightningElement) {
    products = [];
    loading = true;
    error;
    store;

    search = '';
    stockFilter = 'all';
    category = ALL;
    expanded = {};

    mode = 'list'; // 'list' | 'edit' | 'labels' | 'tool'
    editor;
    saving = false;
    labelStyleKey;
    labelQty = {};

    // Barcode panel open under one variant in the list.
    openVariantId;
    variantCopies = 1;
    barcodeDraft = '';
    barcodeBusy = false;
    manualVariantUrl;

    pendingStock = {};
    stockTimers = {};

    connectedCallback() {
        this.load();
        getStoreInfo()
            .then((store) => {
                this.store = store;
            })
            .catch(() => {
                this.store = undefined;
            });
    }

    disconnectedCallback() {
        Object.values(this.stockTimers).forEach((t) => clearTimeout(t));
    }

    @api
    refresh() {
        if (this.mode === 'list') {
            this.load(true);
        }
    }

    async load(silent = false) {
        if (!silent) {
            this.loading = true;
        }
        try {
            this.products = await getProducts();
            this.error = undefined;
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.loading = false;
        }
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    // ---------- grouping ----------

    get styles() {
        const map = new Map();
        this.products.forEach((p) => {
            const key = keyOf(p.Name, p.Brand__c);
            let s = map.get(key);
            if (!s) {
                s = { key, name: p.Name, brand: p.Brand__c, category: p.Category__c || 'Other', variants: [] };
                map.set(key, s);
            }
            s.variants.push(p);
        });
        map.forEach((s) =>
            s.variants.sort(
                (a, b) =>
                    (a.Color__c || '').localeCompare(b.Color__c || '') || compareSizes(a.Size__c || '', b.Size__c || '')
            )
        );
        return [...map.values()];
    }

    matchesStock(p) {
        const stock = num(p.Stock__c);
        switch (this.stockFilter) {
            case 'low':
                return p.Active__c && stock > 0 && stock <= LOW_STOCK;
            case 'out':
                return p.Active__c && stock <= 0;
            case 'inactive':
                return !p.Active__c;
            default:
                return true;
        }
    }

    get summaryText() {
        const styles = this.styles.length;
        const active = this.products.filter((p) => p.Active__c);
        const low = active.filter((p) => num(p.Stock__c) > 0 && num(p.Stock__c) <= LOW_STOCK).length;
        const out = active.filter((p) => num(p.Stock__c) <= 0).length;
        const pieces = active.reduce((t, p) => t + Math.max(0, num(p.Stock__c)), 0);
        const parts = [`${styles} styles`, `${this.products.length} variants`, `${pieces} pcs`];
        if (low) {
            parts.push(`${low} low`);
        }
        if (out) {
            parts.push(`${out} out`);
        }
        return parts.join(' · ');
    }

    get filterChips() {
        return STOCK_FILTERS.map((f) => ({
            ...f,
            cls: `chip${f.name === this.stockFilter ? ' chip_selected' : ''}`,
            pressed: String(f.name === this.stockFilter)
        }));
    }

    get categoryChips() {
        const cats = [...new Set(this.styles.map((s) => s.category))].sort();
        return [ALL, ...cats].map((name) => ({
            name,
            cls: `chip${name === this.category ? ' chip_selected' : ''}`,
            pressed: String(name === this.category)
        }));
    }

    get styleCards() {
        const term = this.search;
        return this.styles
            .filter((s) => this.category === ALL || s.category === this.category)
            .filter((s) => s.variants.some((p) => this.matchesStock(p)))
            .filter(
                (s) =>
                    !term ||
                    [s.name, s.brand, s.category].some((v) => v && v.toLowerCase().includes(term)) ||
                    s.variants.some((p) =>
                        [p.SKU__c, p.Barcode__c, p.Color__c].some((v) => v && v.toLowerCase().includes(term))
                    )
            )
            .map((s) => {
                const active = s.variants.filter((p) => p.Active__c);
                const prices = s.variants.map((p) => num(p.Price__c));
                const min = Math.min(...prices);
                const max = Math.max(...prices);
                const pieces = active.reduce((t, p) => t + Math.max(0, num(p.Stock__c)), 0);
                const low = active.filter((p) => num(p.Stock__c) > 0 && num(p.Stock__c) <= LOW_STOCK).length;
                const out = active.filter((p) => num(p.Stock__c) <= 0).length;
                const colors = [...new Set(s.variants.map((p) => p.Color__c).filter(Boolean))];
                const isOpen = Boolean(this.expanded[s.key]);
                return {
                    key: s.key,
                    name: s.name,
                    sub: [s.brand, s.category].filter(Boolean).join(' · '),
                    priceText: min === max ? money(min) : `${moneyShort(min)} – ${moneyShort(max)}`,
                    stockText: `${pieces} pcs · ${s.variants.length} variant${s.variants.length === 1 ? '' : 's'}`,
                    hasLow: low > 0,
                    lowText: `${low} low`,
                    hasOut: out > 0,
                    outText: `${out} out`,
                    allInactive: !active.length,
                    swatches: colors.slice(0, 8).map((c) => ({ name: c, style: swatchStyle(c) })),
                    isOpen,
                    openAttr: String(isOpen),
                    chevron: isOpen ? 'utility:chevronup' : 'utility:chevrondown',
                    cardCls: `card-item style-card${active.length ? '' : ' style-card_inactive'}`,
                    variants: isOpen ? s.variants.map((p) => this.variantRow(p)) : []
                };
            });
    }

    variantRow(p) {
        const stock = num(p.Stock__c);
        let stockCls = 'stock-badge';
        if (stock <= 0) {
            stockCls += ' stock-badge_out';
        } else if (stock <= LOW_STOCK) {
            stockCls += ' stock-badge_low';
        }
        const barcodeOpen = this.openVariantId === p.Id;
        return {
            id: p.Id,
            name: p.Name,
            price: p.Price__c,
            mrp: p.MRP__c,
            barcode: p.Barcode__c,
            hasBarcode: Boolean(p.Barcode__c),
            stockForCopies: Math.max(0, stock),
            barcodeOpen,
            barcodeExpanded: String(barcodeOpen),
            barcodeBtnCls: `icon-btn icon-btn_small${barcodeOpen ? ' icon-btn_brand' : ''}${p.Barcode__c ? '' : ' icon-btn_missing'}`,
            barcodeBtnTitle: p.Barcode__c ? 'Print barcode labels' : 'No barcode yet',
            label: variantLabel(p),
            swatch: swatchStyle(p.Color__c),
            codes: [p.SKU__c, p.Barcode__c].filter(Boolean).join(' · '),
            priceText: money(p.Price__c),
            stock,
            stockCls,
            active: p.Active__c,
            rowCls: `variant${p.Active__c ? '' : ' variant_inactive'}`,
            activeLabel: p.Active__c ? 'On sale' : 'Hidden',
            activeCls: `chip chip_small${p.Active__c ? ' chip_on' : ''}`,
            activeTitle: p.Active__c ? 'Hide from billing' : 'Show in billing'
        };
    }

    get hasStyles() {
        return this.styleCards.length > 0;
    }

    get isList() {
        return this.mode === 'list';
    }

    get isEdit() {
        return this.mode === 'edit';
    }

    get isLabels() {
        return this.mode === 'labels';
    }

    get isTool() {
        return this.mode === 'tool';
    }

    handleOpenTool() {
        this.mode = 'tool';
        this.scrollTop();
    }

    // ---------- per-variant barcode panel ----------

    get paperWidth() {
        return Number(loadSettings().width) === 80 ? 80 : 58;
    }

    get shopName() {
        return this.store ? this.store.Name : null;
    }

    get variantCopyChips() {
        const product = this.products.find((p) => p.Id === this.openVariantId);
        const stock = product ? Math.max(0, num(product.Stock__c)) : 0;
        const chips = [1, 5, 10].map((n) => ({ value: n, label: String(n) }));
        if (stock > 1 && ![1, 5, 10].includes(stock)) {
            chips.push({ value: stock, label: `${stock} (stock)` });
        }
        return chips.map((c) => ({ ...c, cls: `chip chip_small${c.value === this.variantCopies ? ' chip_selected' : ''}` }));
    }

    get variantPrintLabel() {
        return `Print ${this.variantCopies} label${this.variantCopies === 1 ? '' : 's'}`;
    }

    get barcodeSaveDisabled() {
        return this.barcodeBusy || !this.barcodeDraft.trim();
    }

    mergeProducts(updated) {
        const byId = new Map(updated.map((p) => [p.Id, p]));
        this.products = this.products.map((p) => byId.get(p.Id) || p);
    }

    handleOpenBarcode(event) {
        const id = event.currentTarget.dataset.id;
        this.openVariantId = this.openVariantId === id ? undefined : id;
        this.variantCopies = 1;
        this.barcodeDraft = '';
        this.manualVariantUrl = undefined;
    }

    setVariantCopies(n) {
        this.variantCopies = Math.min(200, Math.max(1, Math.floor(num(n, 1))));
    }

    handleVariantCopyStep(event) {
        this.setVariantCopies(this.variantCopies + Number(event.currentTarget.dataset.delta));
    }

    handleVariantCopyChip(event) {
        this.setVariantCopies(event.currentTarget.dataset.value);
    }

    handleVariantCopiesInput(event) {
        this.setVariantCopies(event.target.value);
        event.target.value = this.variantCopies;
    }

    handlePrintVariant(event) {
        const product = this.products.find((p) => p.Id === event.currentTarget.dataset.id);
        const settings = loadSettings();
        const { bytes, skipped } = buildLabels([{ product, qty: this.variantCopies }], this.store, settings);
        if (skipped.length) {
            this.toast('Barcode too long', 'This barcode does not fit the paper. Set a shorter one below.', 'warning');
            return;
        }
        const result = printBytes(this, bytes, { ...settings, method: 'bluetooth' });
        if (result.error) {
            this.toast('Printer not set up', result.error, 'warning');
        }
        this.manualVariantUrl = result.url;
    }

    async handleGenerateBarcode(event) {
        const id = event.currentTarget.dataset.id;
        this.barcodeBusy = true;
        try {
            this.mergeProducts(await assignBarcodes({ productIds: [id] }));
            this.toast('Barcode created', 'You can print labels now.', 'success');
        } catch (e) {
            this.toast('Could not create barcode', errorMessage(e), 'error');
        } finally {
            this.barcodeBusy = false;
        }
    }

    handleBarcodeDraft(event) {
        this.barcodeDraft = event.detail.value || '';
    }

    async handleSaveBarcode(event) {
        const id = event.currentTarget.dataset.id;
        this.barcodeBusy = true;
        try {
            this.mergeProducts([await setBarcode({ productId: id, barcode: this.barcodeDraft })]);
            this.barcodeDraft = '';
            this.toast('Barcode saved', 'Scanning this code in Billing now adds this item.', 'success');
        } catch (e) {
            this.toast('Could not save barcode', errorMessage(e), 'error');
        } finally {
            this.barcodeBusy = false;
        }
    }

    get emptyText() {
        return this.products.length ? 'No products match these filters.' : 'No products yet. Add your first style.';
    }

    handleSearch(event) {
        this.search = (event.detail.value || '').trim().toLowerCase();
    }

    handleStockFilter(event) {
        this.stockFilter = event.currentTarget.dataset.name;
    }

    handleCategory(event) {
        this.category = event.currentTarget.dataset.name;
    }

    handleToggle(event) {
        const key = event.currentTarget.dataset.key;
        this.expanded = { ...this.expanded, [key]: !this.expanded[key] };
    }

    // ---------- quick stock & active ----------

    patchProduct(id, changes) {
        this.products = this.products.map((p) => (p.Id === id ? { ...p, ...changes } : p));
    }

    handleStockStep(event) {
        const { id, delta } = event.currentTarget.dataset;
        const product = this.products.find((p) => p.Id === id);
        if (!product) {
            return;
        }
        const step = Number(delta);
        this.patchProduct(id, { Stock__c: num(product.Stock__c) + step });
        this.pendingStock = { ...this.pendingStock, [id]: (this.pendingStock[id] || 0) + step };
        clearTimeout(this.stockTimers[id]);
        // Batch quick taps into one server call per variant.
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.stockTimers[id] = setTimeout(() => this.commitStock(id), STOCK_COMMIT_DELAY);
    }

    async commitStock(id) {
        const delta = this.pendingStock[id];
        const rest = { ...this.pendingStock };
        delete rest[id];
        this.pendingStock = rest;
        if (!delta) {
            return;
        }
        try {
            const stock = await adjustStock({ productId: id, delta });
            if (!this.pendingStock[id]) {
                this.patchProduct(id, { Stock__c: stock });
            }
        } catch (e) {
            this.toast('Stock not updated', errorMessage(e), 'error');
            this.load(true);
        }
    }

    async handleToggleActive(event) {
        const id = event.currentTarget.dataset.id;
        const product = this.products.find((p) => p.Id === id);
        const active = !product.Active__c;
        this.patchProduct(id, { Active__c: active });
        try {
            await setActive({ productIds: [id], active });
        } catch (e) {
            this.patchProduct(id, { Active__c: !active });
            this.toast('Could not update', errorMessage(e), 'error');
        }
    }

    // ---------- editor ----------

    handleNew() {
        this.editor = {
            isNew: true,
            originalKey: null,
            name: '',
            brand: '',
            category: this.category !== ALL ? this.category : '',
            hsn: '',
            mrp: null,
            price: null,
            cost: null,
            sizes: [],
            colors: [],
            existing: {},
            opening: {},
            add: {},
            fillOpening: 0,
            newSize: '',
            newColor: ''
        };
        this.mode = 'edit';
        this.scrollTop();
    }

    handleEdit(event) {
        const style = this.styles.find((s) => s.key === event.currentTarget.dataset.key);
        const first = style.variants[0];
        const existing = {};
        style.variants.forEach((p) => {
            existing[cellKey(p.Color__c || '', p.Size__c || '')] = p;
        });
        const sizes = [...new Set(style.variants.filter((p) => p.Active__c).map((p) => p.Size__c || ''))].sort(compareSizes);
        const colors = [...new Set(style.variants.filter((p) => p.Active__c).map((p) => p.Color__c || ''))];
        this.editor = {
            isNew: false,
            originalKey: style.key,
            name: first.Name,
            brand: first.Brand__c || '',
            category: first.Category__c || '',
            hsn: first.HSN__c || '',
            mrp: first.MRP__c,
            price: first.Price__c,
            cost: first.Cost__c,
            sizes: sizes.filter((s) => s !== '' || sizes.length === 1),
            colors: colors.filter((c) => c !== '' || colors.length === 1),
            existing,
            opening: {},
            add: {},
            fillOpening: 0,
            newSize: '',
            newColor: ''
        };
        this.mode = 'edit';
        this.scrollTop();
    }

    handleCancel() {
        this.mode = 'list';
        this.editor = undefined;
        this.scrollTop();
    }

    scrollTop() {
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            const top = this.template.querySelector('.products-top');
            if (top && top.scrollIntoView) {
                top.scrollIntoView({ block: 'start' });
            }
        }, 0);
    }

    setEditor(changes) {
        this.editor = { ...this.editor, ...changes };
    }

    get editorTitle() {
        return this.editor && !this.editor.isNew ? 'Edit style' : 'New style';
    }

    handleField(event) {
        const field = event.target.dataset.field;
        const numeric = ['mrp', 'price', 'cost'].includes(field);
        const value = event.detail.value;
        this.setEditor({ [field]: numeric ? (value === '' ? null : num(value)) : value });
    }

    get categorySuggestions() {
        const current = (this.editor && this.editor.category) || '';
        return [...new Set(this.products.map((p) => p.Category__c).filter(Boolean))].sort().map((name) => ({
            name,
            cls: `chip chip_small${name === current ? ' chip_selected' : ''}`
        }));
    }

    handlePickCategory(event) {
        this.setEditor({ category: event.currentTarget.dataset.name });
    }

    get pricingHint() {
        const e = this.editor;
        if (!e || !e.price) {
            return '';
        }
        const parts = [];
        if (e.mrp && e.mrp > e.price) {
            parts.push(`${Math.round(((e.mrp - e.price) / e.mrp) * 100)}% off MRP`);
        }
        if (e.cost) {
            const margin = e.price - e.cost;
            parts.push(`margin ${money(margin)} (${Math.round((margin / e.price) * 100)}% of price, before GST)`);
        }
        return parts.join(' · ');
    }

    // sizes
    get sizePresets() {
        return SIZE_PRESETS;
    }

    get sizeChips() {
        return this.editor.sizes.map((s) => ({ name: s, label: s || 'No size' }));
    }

    get hasSizes() {
        return this.editor.sizes.length > 0;
    }

    handlePreset(event) {
        const preset = SIZE_PRESETS.find((p) => p.name === event.currentTarget.dataset.name);
        const sizes = [...new Set([...this.editor.sizes.filter(Boolean), ...preset.sizes])].sort(compareSizes);
        this.setEditor({ sizes });
    }

    handleNewSize(event) {
        this.setEditor({ newSize: event.detail.value });
    }

    handleNewSizeKey(event) {
        if (event.key === 'Enter') {
            this.handleAddSize();
        }
    }

    handleAddSize() {
        const size = (this.editor.newSize || '').trim().toUpperCase();
        if (!size) {
            return;
        }
        const sizes = [...new Set([...this.editor.sizes.filter(Boolean), size])].sort(compareSizes);
        this.setEditor({ sizes, newSize: '' });
    }

    handleRemoveSize(event) {
        const name = event.currentTarget.dataset.name;
        this.setEditor({ sizes: this.editor.sizes.filter((s) => s !== name) });
    }

    // colors
    get colorChips() {
        return this.editor.colors.map((c) => ({ name: c, label: c || 'No color', swatch: swatchStyle(c) }));
    }

    get quickColors() {
        const used = new Set(this.editor.colors.map((c) => c.toLowerCase()));
        return QUICK_COLORS.filter((c) => !used.has(c.toLowerCase())).map((c) => ({ name: c, swatch: swatchStyle(c) }));
    }

    get hasColors() {
        return this.editor.colors.length > 0;
    }

    addColor(raw) {
        const color = (raw || '').trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
        if (!color || this.editor.colors.some((c) => c.toLowerCase() === color.toLowerCase())) {
            return;
        }
        this.setEditor({ colors: [...this.editor.colors.filter(Boolean), color], newColor: '' });
    }

    handleQuickColor(event) {
        this.addColor(event.currentTarget.dataset.name);
    }

    handleNewColor(event) {
        this.setEditor({ newColor: event.detail.value });
    }

    handleNewColorKey(event) {
        if (event.key === 'Enter') {
            this.addColor(this.editor.newColor);
        }
    }

    handleAddColor() {
        this.addColor(this.editor.newColor);
    }

    handleRemoveColor(event) {
        const name = event.currentTarget.dataset.name;
        this.setEditor({ colors: this.editor.colors.filter((c) => c !== name) });
    }

    // variant matrix
    get gridColors() {
        return this.editor.colors.length ? this.editor.colors : [''];
    }

    get gridSizes() {
        return this.editor.sizes.length ? this.editor.sizes : [''];
    }

    get matrix() {
        const e = this.editor;
        return this.gridColors.map((color) => ({
            color,
            label: color || 'All',
            swatch: swatchStyle(color),
            cells: this.gridSizes.map((size) => {
                const key = cellKey(color, size);
                const existing = e.existing[key];
                return {
                    key,
                    size: size || 'One size',
                    isExisting: Boolean(existing),
                    stockText: existing ? `In stock ${num(existing.Stock__c)}` : 'New',
                    value: existing ? e.add[key] || '' : e.opening[key] ?? e.fillOpening,
                    placeholder: existing ? '+ add' : '0',
                    inputLabel: existing ? `Add stock for ${color} ${size}` : `Opening stock for ${color} ${size}`,
                    cls: `cell${existing ? ' cell_existing' : ''}`
                };
            })
        }));
    }

    get variantCount() {
        return this.gridColors.length * this.gridSizes.length;
    }

    get removedCount() {
        const keep = new Set(this.gridColors.flatMap((c) => this.gridSizes.map((s) => cellKey(c, s))));
        return Object.entries(this.editor.existing).filter(([key, p]) => p.Active__c && !keep.has(key)).length;
    }

    get hasRemoved() {
        return this.removedCount > 0;
    }

    get removedText() {
        const n = this.removedCount;
        return `${n} variant${n === 1 ? '' : 's'} no longer in the grid will be hidden from billing (not deleted).`;
    }

    handleFillOpening(event) {
        this.setEditor({ fillOpening: Math.max(0, Math.floor(num(event.detail.value))), opening: {} });
    }

    handleCellChange(event) {
        const key = event.target.dataset.key;
        const value = Math.max(0, Math.floor(num(event.detail.value)));
        if (this.editor.existing[key]) {
            this.setEditor({ add: { ...this.editor.add, [key]: value } });
        } else {
            this.setEditor({ opening: { ...this.editor.opening, [key]: value } });
        }
    }

    get saveStyleLabel() {
        if (this.saving) {
            return 'Saving…';
        }
        return this.editor.isNew ? `Create ${this.variantCount} variant${this.variantCount === 1 ? '' : 's'}` : 'Save changes';
    }

    async handleSaveStyle() {
        const inputs = [...this.template.querySelectorAll('.editor lightning-input[data-field]')];
        const valid = inputs.reduce((ok, input) => input.reportValidity() && ok, true);
        if (!valid) {
            return;
        }
        const e = this.editor;
        const keep = new Set();
        const variants = [];
        this.gridColors.forEach((color) => {
            this.gridSizes.forEach((size) => {
                const key = cellKey(color, size);
                keep.add(key);
                const existing = e.existing[key];
                variants.push(
                    existing
                        ? { id: existing.Id, size, color, addStock: num(e.add[key]), active: true }
                        : { size, color, stock: num(e.opening[key] ?? e.fillOpening), active: true }
                );
            });
        });
        Object.entries(e.existing).forEach(([key, p]) => {
            if (!keep.has(key)) {
                variants.push({ id: p.Id, size: p.Size__c, color: p.Color__c, addStock: 0, active: false });
            }
        });

        this.saving = true;
        try {
            await saveStyle({
                styleJson: JSON.stringify({
                    name: e.name,
                    brand: e.brand,
                    category: e.category,
                    hsn: e.hsn,
                    mrp: e.mrp,
                    price: e.price,
                    cost: e.cost,
                    variants
                })
            });
            this.toast(e.isNew ? 'Style created' : 'Style saved', e.name, 'success');
            const key = keyOf(e.name.trim(), (e.brand || '').trim());
            this.expanded = { ...this.expanded, [key]: true };
            this.mode = 'list';
            this.editor = undefined;
            await this.load(true);
            this.scrollTop();
        } catch (err) {
            this.toast('Could not save', errorMessage(err), 'error');
        } finally {
            this.saving = false;
        }
    }

    // ---------- labels ----------

    get labelStyle() {
        return this.styles.find((s) => s.key === this.labelStyleKey);
    }

    handleLabels(event) {
        this.labelStyleKey = event.currentTarget.dataset.key;
        const qty = {};
        this.labelStyle.variants.filter((p) => p.Active__c).forEach((p) => {
            qty[p.Id] = 1;
        });
        this.labelQty = qty;
        this.mode = 'labels';
        this.scrollTop();
    }

    get labelRows() {
        const s = this.labelStyle;
        if (!s) {
            return [];
        }
        return s.variants
            .filter((p) => p.Active__c)
            .map((p) => ({
                id: p.Id,
                label: variantLabel(p),
                swatch: swatchStyle(p.Color__c),
                code: p.Barcode__c || p.SKU__c,
                stock: num(p.Stock__c),
                qty: this.labelQty[p.Id] || 0
            }));
    }

    get labelTotal() {
        return Object.values(this.labelQty).reduce((t, n) => t + num(n), 0);
    }

    get labelPrintLabel() {
        const n = this.labelTotal;
        return `Print ${n} label${n === 1 ? '' : 's'}`;
    }

    get labelPrintDisabled() {
        return this.labelTotal <= 0;
    }

    get labelsNeedBluetooth() {
        return loadSettings().method !== 'bluetooth';
    }

    handleLabelStep(event) {
        const { id, delta } = event.currentTarget.dataset;
        this.labelQty = { ...this.labelQty, [id]: Math.max(0, (this.labelQty[id] || 0) + Number(delta)) };
    }

    handleLabelsFromStock() {
        const qty = {};
        this.labelRows.forEach((r) => {
            qty[r.id] = Math.max(0, r.stock);
        });
        this.labelQty = qty;
    }

    handleLabelsClear() {
        const qty = {};
        this.labelRows.forEach((r) => {
            qty[r.id] = 0;
        });
        this.labelQty = qty;
    }

    get missingBarcodeIds() {
        const s = this.labelStyle;
        return s ? s.variants.filter((p) => p.Active__c && !p.Barcode__c).map((p) => p.Id) : [];
    }

    get hasMissingBarcodes() {
        return this.missingBarcodeIds.length > 0;
    }

    get missingBarcodeText() {
        const n = this.missingBarcodeIds.length;
        return `${n} variant${n === 1 ? ' has' : 's have'} no barcode and will be skipped.`;
    }

    async handleGenerateMissing() {
        this.barcodeBusy = true;
        try {
            this.mergeProducts(await assignBarcodes({ productIds: this.missingBarcodeIds }));
            this.toast('Barcodes created', 'Every variant in this style now has a barcode.', 'success');
        } catch (e) {
            this.toast('Could not create barcodes', errorMessage(e), 'error');
        } finally {
            this.barcodeBusy = false;
        }
    }

    handlePrintLabels() {
        const settings = loadSettings();
        const items = this.labelStyle.variants
            .filter((p) => this.labelQty[p.Id] > 0)
            .map((p) => ({ product: p, qty: this.labelQty[p.Id] }));
        const { bytes, skipped } = buildLabels(items, this.store, settings);
        if (skipped.length === items.length) {
            this.toast('Nothing to print', 'The selected variants have no printable barcode yet.', 'warning');
            return;
        }
        const result = printBytes(this, bytes, { ...settings, method: 'bluetooth' });
        if (result.error) {
            this.toast('Printer not set up', result.error, 'warning');
        } else if (skipped.length) {
            this.toast('Some labels skipped', `${skipped.length} variant(s) have no printable barcode.`, 'warning');
        }
        this.manualLabelUrl = result.url;
    }

    manualLabelUrl;
}
