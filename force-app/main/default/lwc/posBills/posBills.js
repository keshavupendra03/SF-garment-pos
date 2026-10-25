import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getBills from '@salesforce/apex/PosController.getBills';
import getStoreInfo from '@salesforce/apex/PosController.getStoreInfo';
import {
    IS_PHONE,
    PAY_MODE_META,
    addDays,
    errorMessage,
    monthStart,
    money,
    num,
    openUrl,
    parseNdjson,
    payLabel,
    round2,
    shareText,
    todayIn,
    whatsappUrl
} from 'c/posUtils';
import { printBill } from 'c/posPrint';

const CURRENCY = { type: 'currency', typeAttributes: { currencyCode: 'INR' }, cellAttributes: { alignment: 'right' } };

const RANGES = [
    { name: 'today', label: 'Today' },
    { name: 'yesterday', label: 'Yesterday' },
    { name: 'week', label: 'Last 7 days' },
    { name: 'month', label: 'This month' },
    { name: 'custom', label: 'Custom' }
];

const KINDS = [
    { name: 'all', label: 'All' },
    { name: 'sales', label: 'Sales' },
    { name: 'returns', label: 'Returns' }
];

export default class PosBills extends NavigationMixin(LightningElement) {
    range = 'today';
    kind = 'all';
    fromDate = todayIn();
    toDate = todayIn();
    filter = '';
    docs = [];
    expandedNo;
    loading = false;
    error;
    store;
    manualPrintUrl;
    useCards = IS_PHONE;

    columns = [
        { label: 'No', fieldName: 'no', initialWidth: 130 },
        { label: 'Type', fieldName: 'typeText', initialWidth: 90 },
        { label: 'Date', fieldName: 'dt', initialWidth: 110 },
        { label: 'Time', fieldName: 'tm', initialWidth: 80 },
        { label: 'Customer', fieldName: 'customer' },
        { label: 'Qty', fieldName: 'items', type: 'number', initialWidth: 70 },
        { label: 'GST', fieldName: 'signedTax', ...CURRENCY },
        { label: 'Total', fieldName: 'signedTotal', ...CURRENCY },
        { label: 'Payment / refund', fieldName: 'payText' },
        { type: 'action', typeAttributes: { rowActions: (row, done) => done(this.rowActions(row)) } }
    ];

    async connectedCallback() {
        await this.loadStore();
        this.applyRange();
        this.load();
    }

    // The store's time zone decides what "today" means (bills are filed by the shop's date).
    async loadStore() {
        try {
            this.store = await getStoreInfo();
        } catch (e) {
            this.store = undefined;
        }
    }

    get timeZone() {
        return this.store && this.store.Time_Zone__c;
    }

    @api
    async refresh() {
        await this.loadStore();
        // Roll quick ranges forward if the day changed while the app stayed open.
        this.applyRange();
        this.load();
    }

    async load() {
        this.loading = true;
        try {
            const text = await getBills({ fromDate: this.fromDate, toDate: this.toDate });
            this.docs = parseNdjson(text).map((b) => this.decorate(b)).reverse();
            this.error = undefined;
        } catch (e) {
            this.error = errorMessage(e);
            this.docs = [];
        } finally {
            this.loading = false;
        }
    }

    decorate(b) {
        const isNote = b.k === 'CN';
        const sign = isNote ? -1 : 1;
        const returnedPieces = (b.l || []).reduce((t, l) => t + num(l.rq), 0);
        const remaining = (b.l || []).reduce((t, l) => t + Math.max(0, num(l.q) - num(l.rq)), 0);
        const payText = (b.pay || []).map((p) => `${payLabel(p.m)}${p.ref ? ` ${p.ref}` : ''} ${money(p.a)}`);
        if (isNote && num(b.bal) > 0) {
            payText.push(`Credit note ${money(b.bal)}`);
        }
        return {
            ...b,
            isNote,
            typeText: isNote ? 'Return' : 'Sale',
            customer: b.cu ? [b.cu.n, b.cu.m].filter(Boolean).join(' · ') : 'Walk-in',
            items: (b.l || []).reduce((t, l) => t + num(l.q), 0),
            signedTotal: sign * num(b.g),
            signedTax: sign * num(b.tx),
            payText: payText.join(', '),
            payModes: isNote
                ? `Against ${b.ref}`
                : (b.pay || []).map((p) => payLabel(p.m)).join(' + '),
            gText: isNote ? `−${money(b.g)}` : money(b.g),
            hasDue: !isNote && num(b.due) > 0,
            dueText: money(b.due),
            canReturn: !isNote && remaining > 0,
            returnedText: !isNote && returnedPieces > 0 ? `${returnedPieces} returned` : '',
            cardCls: `card-item${isNote ? ' card-item_note' : ''}`,
            lineRows: (b.l || []).map((l, i) => ({
                key: `${b.no}-${i}`,
                name: l.n,
                variant: [l.z, l.c].filter(Boolean).join(' / '),
                qty: num(l.rq) > 0 ? `×${l.q} (${l.rq} back)` : `×${l.q}`,
                amount: money(l.net)
            }))
        };
    }

    // ---------- range & filters ----------

    get rangeChips() {
        return RANGES.map((r) => ({
            ...r,
            cls: `chip${r.name === this.range ? ' chip_selected' : ''}`,
            pressed: String(r.name === this.range)
        }));
    }

    get kindChips() {
        return KINDS.map((k) => ({
            ...k,
            cls: `chip chip_small${k.name === this.kind ? ' chip_selected' : ''}`,
            pressed: String(k.name === this.kind)
        }));
    }

    get isCustom() {
        return this.range === 'custom';
    }

    handleRange(event) {
        this.range = event.currentTarget.dataset.name;
        if (this.range !== 'custom') {
            this.applyRange();
            this.load();
        }
    }

    handleKind(event) {
        this.kind = event.currentTarget.dataset.name;
    }

    applyRange() {
        const today = todayIn(this.timeZone);
        if (this.range === 'today') {
            this.fromDate = this.toDate = today;
        } else if (this.range === 'yesterday') {
            this.fromDate = this.toDate = addDays(today, -1);
        } else if (this.range === 'week') {
            this.fromDate = addDays(today, -6);
            this.toDate = today;
        } else if (this.range === 'month') {
            this.fromDate = monthStart(today);
            this.toDate = today;
        }
    }

    handleFromChange(event) {
        this.fromDate = event.detail.value;
    }

    handleToChange(event) {
        this.toDate = event.detail.value;
    }

    handleFilterChange(event) {
        this.filter = (event.detail.value || '').toLowerCase();
    }

    // ---------- actions ----------

    findDoc(no) {
        return this.docs.find((b) => b.no === no);
    }

    rowActions(row) {
        const actions = [
            { label: row.isNote ? 'Print credit note' : 'Print receipt', name: 'print', iconName: 'utility:print' },
            { label: 'Send on WhatsApp', name: 'share', iconName: 'utility:share' }
        ];
        if (row.canReturn) {
            actions.push({ label: 'Return / exchange', name: 'return', iconName: 'utility:undo' });
        }
        return actions;
    }

    print(doc) {
        const result = printBill(this, doc, this.store);
        this.manualPrintUrl = result.url;
        if (result.error) {
            this.error = result.error;
        }
    }

    share(doc) {
        openUrl(this, whatsappUrl(doc.cu ? doc.cu.m : null, shareText(doc, this.store && this.store.Name)));
    }

    startReturn(doc) {
        this.dispatchEvent(new CustomEvent('startreturn', { detail: { query: doc.no } }));
    }

    handleRowAction(event) {
        const row = event.detail.row;
        const name = event.detail.action.name;
        if (name === 'print') {
            this.print(row);
        } else if (name === 'share') {
            this.share(row);
        } else if (name === 'return') {
            this.startReturn(row);
        }
    }

    handleToggle(event) {
        const no = event.currentTarget.dataset.no;
        this.expandedNo = this.expandedNo === no ? undefined : no;
    }

    handlePrint(event) {
        this.print(this.findDoc(event.currentTarget.dataset.no));
    }

    handleShare(event) {
        this.share(this.findDoc(event.currentTarget.dataset.no));
    }

    handleReturn(event) {
        this.startReturn(this.findDoc(event.currentTarget.dataset.no));
    }

    // ---------- view ----------

    get visibleBills() {
        let list = this.docs;
        if (this.kind === 'sales') {
            list = list.filter((b) => !b.isNote);
        } else if (this.kind === 'returns') {
            list = list.filter((b) => b.isNote);
        }
        if (this.filter) {
            list = list.filter((b) => `${b.no} ${b.ref || ''} ${b.customer}`.toLowerCase().includes(this.filter));
        }
        return list.map((b) => ({ ...b, expanded: b.no === this.expandedNo, expandedAttr: String(b.no === this.expandedNo) }));
    }

    get hasBills() {
        return this.visibleBills.length > 0;
    }

    get summary() {
        const sales = this.docs.filter((b) => !b.isNote);
        const notes = this.docs.filter((b) => b.isNote);
        const sum = (list, key) => round2(list.reduce((t, b) => t + num(b[key]), 0));
        const salesTotal = sum(sales, 'g');
        const returnsTotal = sum(notes, 'g');

        // Money by mode: collected on sales, minus refunds paid out on returns, minus change given.
        const modes = Object.keys(PAY_MODE_META);
        const byMode = modes
            .map((mode) => {
                const inflow = sales.reduce((t, b) => t + (b.pay || []).filter((p) => p.m === mode).reduce((s, p) => s + num(p.a), 0), 0);
                const outflow = notes.reduce((t, b) => t + (b.pay || []).filter((p) => p.m === mode).reduce((s, p) => s + num(p.a), 0), 0);
                const change = mode === 'CASH' ? sum(sales, 'chg') : 0;
                const amount = round2(inflow - outflow - change);
                return { mode, label: mode === 'DUE' ? 'Dues reduced' : mode === 'CN' ? 'Credit notes used' : payLabel(mode), amount, text: money(amount) };
            })
            .filter((m) => m.amount);
        const openCredit = sum(notes, 'bal');
        if (openCredit > 0) {
            byMode.push({ mode: 'NEWCN', label: 'Credit notes issued', amount: openCredit, text: money(openCredit) });
        }
        return {
            count: sales.length,
            net: money(salesTotal - returnsTotal),
            returns: notes.length ? `${notes.length} · ${money(returnsTotal)}` : '0',
            tax: money(sum(sales, 'tx') - sum(notes, 'tx')),
            discount: money(sum(sales, 'dis')),
            byMode
        };
    }
}
