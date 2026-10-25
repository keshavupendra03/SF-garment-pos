import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import findBills from '@salesforce/apex/PosReturnController.findBills';
import processReturn from '@salesforce/apex/PosReturnController.processReturn';
import findCustomer from '@salesforce/apex/PosController.findCustomer';
import getStoreInfo from '@salesforce/apex/PosController.getStoreInfo';
import {
    IS_DESKTOP,
    daysBetween,
    errorMessage,
    money,
    num,
    openUrl,
    payLabel,
    returnLineValue,
    round2,
    shareText,
    swatchStyle,
    todayIn,
    whatsappUrl
} from 'c/posUtils';
import { loadSettings, printBill } from 'c/posPrint';

const REASONS = ['Size issue', 'Color / style', 'Defect / damage', 'Changed mind', 'Other'];
const DAMAGE_REASON = 'Defect / damage';

const OUTCOMES = [
    { value: 'exchange', label: 'Exchange', icon: 'utility:sync', hint: 'Pick new items now. Credit is applied to the new bill.' },
    { value: 'refund', label: 'Refund', icon: 'utility:money', hint: 'Give the money back.' },
    { value: 'credit', label: 'Credit note', icon: 'utility:note', hint: 'Customer uses it on a later visit.' }
];

const REFUND_MODES = [
    { value: 'CASH', icon: 'utility:money' },
    { value: 'UPI', icon: 'utility:phone_portrait' },
    { value: 'CARD', icon: 'utility:payment_gateway' }
];

/**
 * Return / exchange wizard: find bill -> choose items -> choose outcome -> done.
 * Fires `close`, and `exchange` (detail: the credit note) when the customer exchanges.
 */
export default class PosReturn extends NavigationMixin(LightningElement) {
    @api initialQuery;

    step = 'find';
    store;
    query = '';
    searching = false;
    searched = false;
    results = [];
    error;

    bill;
    qty = {};
    restock = {};
    reason = '';
    customer;

    outcome = 'exchange';
    refundMode = 'CASH';
    saving = false;
    note;
    manualPrintUrl;
    focused = false;

    connectedCallback() {
        getStoreInfo()
            .then((store) => {
                this.store = store;
            })
            .catch(() => {
                this.store = undefined;
            });
        if (this.initialQuery) {
            this.query = this.initialQuery;
            this.search();
        }
    }

    renderedCallback() {
        // Desktop only: on phones focusing pops the keyboard before the user chooses scan or type.
        if (IS_DESKTOP && this.step === 'find' && !this.focused) {
            const input = this.template.querySelector('[data-id="query"]');
            if (input) {
                this.focused = true;
                input.focus();
            }
        }
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    // ---------- steps ----------

    get isFind() {
        return this.step === 'find';
    }
    get isItems() {
        return this.step === 'items';
    }
    get isOutcome() {
        return this.step === 'outcome';
    }
    get isDone() {
        return this.step === 'done';
    }

    get stepper() {
        const steps = ['find', 'items', 'outcome', 'done'];
        const labels = ['Find bill', 'Items', 'Refund / exchange', 'Done'];
        const current = steps.indexOf(this.step);
        return steps.map((s, i) => ({
            key: s,
            label: labels[i],
            num: i + 1,
            cls: `step${i < current ? ' step_done' : ''}${i === current ? ' step_current' : ''}`
        }));
    }

    handleClose() {
        this.dispatchEvent(new CustomEvent('close'));
    }

    handleBack() {
        if (this.step === 'items') {
            this.step = 'find';
            this.focused = false;
        } else if (this.step === 'outcome') {
            this.step = 'items';
        } else {
            this.handleClose();
        }
    }

    // ---------- find ----------

    handleQuery(event) {
        this.query = event.detail.value || '';
    }

    handleQueryKey(event) {
        if (event.key === 'Enter') {
            this.query = event.target.value || '';
            this.search();
        }
    }

    async search() {
        const q = (this.query || '').trim();
        if (!q) {
            return;
        }
        this.searching = true;
        this.error = undefined;
        try {
            this.results = await findBills({ query: q });
            this.searched = true;
            if (this.results.length === 1 && !/^[0-9]{10}$/.test(q)) {
                this.pickBill(this.results[0]);
            }
        } catch (e) {
            this.error = errorMessage(e);
            this.results = [];
        } finally {
            this.searching = false;
        }
    }

    handleSearch() {
        this.search();
    }

    get today() {
        return todayIn(this.store && this.store.Time_Zone__c);
    }

    get returnDays() {
        return num(this.store && this.store.Return_Days__c, 7);
    }

    ageText(dt) {
        const days = daysBetween(dt, this.today);
        if (days <= 0) {
            return 'Today';
        }
        return days === 1 ? 'Yesterday' : `${days} days ago`;
    }

    remainingOf(bill) {
        return (bill.l || []).reduce((t, l) => t + Math.max(0, num(l.q) - num(l.rq)), 0);
    }

    get resultCards() {
        return this.results.map((b) => {
            const remaining = this.remainingOf(b);
            const old = daysBetween(b.dt, this.today) > this.returnDays;
            return {
                no: b.no,
                title: b.no,
                meta: `${b.dt} ${b.tm} · ${this.ageText(b.dt)}`,
                customer: b.cu ? [b.cu.n, b.cu.m].filter(Boolean).join(' · ') : 'Walk-in',
                total: money(b.g),
                items: `${(b.l || []).reduce((t, l) => t + num(l.q), 0)} pcs`,
                disabled: remaining <= 0,
                badge: remaining <= 0 ? 'Fully returned' : old ? 'Past return window' : b.cn ? 'Part returned' : '',
                badgeCls: `pill${remaining <= 0 || old ? ' pill_warn' : ''}`,
                cls: `card-item result${remaining <= 0 ? ' result_disabled' : ''}`
            };
        });
    }

    get hasResults() {
        return this.results.length > 0;
    }

    get noResults() {
        return this.searched && !this.searching && !this.results.length && !this.error;
    }

    handlePick(event) {
        const bill = this.results.find((b) => b.no === event.currentTarget.dataset.no);
        if (bill && this.remainingOf(bill) > 0) {
            this.pickBill(bill);
        }
    }

    async pickBill(bill) {
        this.bill = bill;
        this.qty = {};
        const restock = {};
        (bill.l || []).forEach((l, i) => {
            restock[i] = true;
        });
        this.restock = restock;
        this.reason = '';
        this.outcome = 'exchange';
        this.refundMode = 'CASH';
        this.customer = undefined;
        this.step = 'items';
        // A single remaining piece is almost always the one coming back.
        const open = (bill.l || []).map((l, i) => ({ i, left: num(l.q) - num(l.rq) })).filter((x) => x.left > 0);
        if (open.length === 1 && open[0].left === 1) {
            this.qty = { [open[0].i]: 1 };
        }
        if (bill.cu && bill.cu.m) {
            try {
                this.customer = await findCustomer({ mobile: bill.cu.m });
            } catch (e) {
                this.customer = undefined;
            }
        }
    }

    // ---------- items ----------

    get billHeader() {
        const b = this.bill;
        if (!b) {
            return {};
        }
        return {
            no: b.no,
            meta: `${b.dt} ${b.tm} · ${this.ageText(b.dt)} · ${money(b.g)}`,
            customer: b.cu ? [b.cu.n, b.cu.m].filter(Boolean).join(' · ') : 'Walk-in customer'
        };
    }

    get pastWindow() {
        return this.bill && daysBetween(this.bill.dt, this.today) > this.returnDays;
    }

    get windowText() {
        const days = this.bill ? daysBetween(this.bill.dt, this.today) : 0;
        return `This bill is ${days} days old. Your return window is ${this.returnDays} days. You can still continue.`;
    }

    get itemRows() {
        return (this.bill.l || []).map((l, i) => {
            const left = Math.max(0, num(l.q) - num(l.rq));
            const q = this.qty[i] || 0;
            const value = returnLineValue(l, q);
            const restock = this.restock[i] !== false;
            return {
                idx: i,
                name: l.n,
                meta: [l.z, l.c, l.s].filter(Boolean).join(' · '),
                swatch: swatchStyle(l.c),
                paid: `${money(num(l.net) / num(l.q))} paid each`,
                soldText: num(l.rq) > 0 ? `Bought ${l.q} · ${l.rq} already returned` : `Bought ${l.q}`,
                left,
                q,
                none: left <= 0,
                selected: q > 0,
                decDisabled: q <= 0,
                incDisabled: q >= left,
                amountText: q > 0 ? money(value.amount) : '',
                restock,
                restockLabel: restock ? 'Back to stock' : 'Damaged',
                restockCls: `chip chip_small${restock ? ' chip_on' : ' chip_warn'}`,
                rowCls: `ret-line${q > 0 ? ' ret-line_on' : ''}${left <= 0 ? ' ret-line_none' : ''}`
            };
        });
    }

    handleQtyStep(event) {
        const idx = Number(event.currentTarget.dataset.idx);
        const line = this.bill.l[idx];
        const left = Math.max(0, num(line.q) - num(line.rq));
        const next = Math.min(left, Math.max(0, (this.qty[idx] || 0) + Number(event.currentTarget.dataset.delta)));
        this.qty = { ...this.qty, [idx]: next };
    }

    handleAll() {
        const qty = {};
        (this.bill.l || []).forEach((l, i) => {
            qty[i] = Math.max(0, num(l.q) - num(l.rq));
        });
        this.qty = qty;
    }

    handleRestock(event) {
        const idx = Number(event.currentTarget.dataset.idx);
        this.restock = { ...this.restock, [idx]: this.restock[idx] === false };
    }

    get reasonChips() {
        return REASONS.map((r) => ({
            value: r,
            cls: `chip chip_small${r === this.reason ? ' chip_selected' : ''}`,
            pressed: String(r === this.reason)
        }));
    }

    handleReason(event) {
        const reason = event.currentTarget.dataset.value;
        this.reason = this.reason === reason ? '' : reason;
        // Damaged goods should not go back on the shelf by default.
        const restock = {};
        (this.bill.l || []).forEach((l, i) => {
            restock[i] = this.reason !== DAMAGE_REASON;
        });
        this.restock = restock;
    }

    get selectedLines() {
        return (this.bill ? this.bill.l || [] : [])
            .map((l, i) => ({ l, i, q: this.qty[i] || 0 }))
            .filter((x) => x.q > 0);
    }

    get totals() {
        let amount = 0;
        let tax = 0;
        let pieces = 0;
        this.selectedLines.forEach(({ l, q }) => {
            const v = returnLineValue(l, q);
            amount += v.amount;
            tax += v.tax;
            pieces += q;
        });
        const credit = Math.round(round2(amount));
        return { pieces, credit, creditText: money(credit), taxText: money(tax) };
    }

    get hasSelection() {
        return this.totals.pieces > 0;
    }

    get itemsNextDisabled() {
        return !this.hasSelection;
    }

    get itemsSummary() {
        const t = this.totals;
        return t.pieces ? `${t.pieces} piece${t.pieces === 1 ? '' : 's'} · credit ${t.creditText}` : 'Choose the items coming back';
    }

    handleToOutcome() {
        this.step = 'outcome';
    }

    // ---------- outcome ----------

    get outcomeCards() {
        return OUTCOMES.map((o) => ({
            ...o,
            cls: `outcome${o.value === this.outcome ? ' outcome_selected' : ''}`,
            pressed: String(o.value === this.outcome)
        }));
    }

    get isRefund() {
        return this.outcome === 'refund';
    }

    get customerDue() {
        return this.customer ? num(this.customer.du) : 0;
    }

    get refundTiles() {
        const tiles = REFUND_MODES.map((m) => ({ ...m, label: payLabel(m.value), disabled: false }));
        if (this.customerDue > 0) {
            tiles.push({
                value: 'DUE',
                icon: 'utility:clock',
                label: `Adjust dues (${money(this.customerDue)})`,
                disabled: this.customerDue < this.totals.credit
            });
        }
        return tiles.map((t) => ({
            ...t,
            cls: `pay-tile${t.value === this.refundMode ? ' pay-tile_selected' : ''}`,
            pressed: String(t.value === this.refundMode)
        }));
    }

    handleOutcome(event) {
        this.outcome = event.currentTarget.dataset.value;
    }

    handleRefundMode(event) {
        this.refundMode = event.currentTarget.dataset.value;
    }

    get confirmLabel() {
        if (this.saving) {
            return 'Saving…';
        }
        const credit = this.totals.creditText;
        if (this.outcome === 'exchange') {
            return `Continue to exchange · ${credit} credit`;
        }
        if (this.outcome === 'credit') {
            return `Create credit note · ${credit}`;
        }
        return this.refundMode === 'DUE' ? `Reduce dues by ${credit}` : `Refund ${credit} by ${payLabel(this.refundMode)}`;
    }

    get outcomeHint() {
        if (this.outcome === 'exchange') {
            return 'Next you scan the new items. If they cost more, the customer pays the difference. If less, the rest stays on the credit note.';
        }
        if (this.outcome === 'credit') {
            return 'A credit note is printed. Scan it or enter its number at billing to use it.';
        }
        return 'Hand the money back after saving.';
    }

    async handleConfirm() {
        if (this.saving) {
            return;
        }
        this.saving = true;
        try {
            const outcome = this.outcome === 'refund' ? 'refund' : 'credit';
            const note = await processReturn({
                returnJson: JSON.stringify({
                    billNo: this.bill.no,
                    billDate: this.bill.dt,
                    reason: this.reason,
                    outcome,
                    refundMode: outcome === 'refund' ? this.refundMode : null,
                    lines: this.selectedLines.map(({ i, q }) => ({ idx: i, q, restock: this.restock[i] !== false }))
                })
            });
            if (this.outcome === 'exchange') {
                this.dispatchEvent(new CustomEvent('exchange', { detail: { note } }));
                return;
            }
            this.note = note;
            this.step = 'done';
            if (loadSettings().autoPrint) {
                this.print();
            }
        } catch (e) {
            this.toast('Return not saved', errorMessage(e), 'error');
        } finally {
            this.saving = false;
        }
    }

    // ---------- done ----------

    get doneTitle() {
        return this.note ? `${this.note.no} saved` : '';
    }

    get doneText() {
        const n = this.note;
        if (!n) {
            return '';
        }
        if (num(n.bal) > 0) {
            return `Credit note for ${money(n.bal)}. The customer can use it on a later visit.`;
        }
        const pay = (n.pay || [])[0];
        if (pay && pay.m === 'DUE') {
            return `Dues reduced by ${money(pay.a)}.`;
        }
        return pay ? `Give back ${money(pay.a)} by ${payLabel(pay.m)}.` : '';
    }

    print() {
        const result = printBill(this, this.note, this.store);
        this.manualPrintUrl = result.url;
        if (result.error) {
            this.toast('Printer not set up', result.error, 'warning');
        }
    }

    handlePrint() {
        this.print();
    }

    handleShare() {
        const n = this.note;
        openUrl(this, whatsappUrl(n.cu ? n.cu.m : null, shareText(n, this.store && this.store.Name)));
    }

    get canShare() {
        return Boolean(this.note && this.note.cu);
    }

    handleNewReturn() {
        this.step = 'find';
        this.query = '';
        this.results = [];
        this.searched = false;
        this.bill = undefined;
        this.note = undefined;
        this.manualPrintUrl = undefined;
        this.focused = false;
    }
}
