import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getCustomers from '@salesforce/apex/PosController.getCustomers';
import { IS_PHONE, errorMessage, initials, money, moneyShort, num, openUrl, whatsappUrl } from 'c/posUtils';

const CURRENCY = { type: 'currency', typeAttributes: { currencyCode: 'INR' }, cellAttributes: { alignment: 'right' } };

const FILTERS = [
    { name: 'all', label: 'All' },
    { name: 'due', label: 'With credit due' },
    { name: 'top', label: 'Top spenders' }
];

export default class PosCustomers extends NavigationMixin(LightningElement) {
    customers = [];
    search = '';
    filter = 'all';
    loading = false;
    error;
    sortedBy = 'l';
    sortedDirection = 'desc';
    useCards = IS_PHONE;

    columns = [
        { label: 'Mobile', fieldName: 'm', initialWidth: 130 },
        { label: 'Name', fieldName: 'n', sortable: true },
        { label: 'Visits', fieldName: 'v', type: 'number', sortable: true, initialWidth: 90 },
        { label: 'Total Spent', fieldName: 's', sortable: true, ...CURRENCY },
        { label: 'Points', fieldName: 'pt', type: 'number', sortable: true, initialWidth: 90 },
        { label: 'Credit Due', fieldName: 'du', sortable: true, ...CURRENCY },
        { label: 'First Visit', fieldName: 'f', initialWidth: 120 },
        { label: 'Last Visit', fieldName: 'l', sortable: true, initialWidth: 120 },
        {
            type: 'action',
            typeAttributes: { rowActions: [{ label: 'WhatsApp', name: 'chat', iconName: 'utility:share' }] }
        }
    ];

    connectedCallback() {
        this.load();
    }

    @api
    refresh() {
        this.load();
    }

    async load() {
        this.loading = true;
        try {
            const shards = await getCustomers();
            const list = [];
            shards.forEach((text) => {
                const map = JSON.parse(text || '{}');
                Object.keys(map).forEach((mobile) => {
                    const c = map[mobile];
                    list.push({
                        m: mobile,
                        n: c.n || '',
                        v: num(c.v),
                        s: num(c.s),
                        pt: num(c.pt),
                        du: num(c.du),
                        f: c.f,
                        l: c.l
                    });
                });
            });
            this.customers = this.sortList(list, this.sortedBy, this.sortedDirection);
            this.error = undefined;
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.loading = false;
        }
    }

    sortList(list, field, direction) {
        const dir = direction === 'asc' ? 1 : -1;
        return [...list].sort((a, b) => {
            const x = a[field] ?? '';
            const y = b[field] ?? '';
            return x > y ? dir : x < y ? -dir : 0;
        });
    }

    handleSort(event) {
        this.sortedBy = event.detail.fieldName;
        this.sortedDirection = event.detail.sortDirection;
        this.customers = this.sortList(this.customers, this.sortedBy, this.sortedDirection);
    }

    handleSearchChange(event) {
        this.search = (event.detail.value || '').toLowerCase();
    }

    get filterChips() {
        return FILTERS.map((f) => ({
            ...f,
            cls: `chip${f.name === this.filter ? ' chip_selected' : ''}`,
            pressed: String(f.name === this.filter)
        }));
    }

    handleFilter(event) {
        this.filter = event.currentTarget.dataset.name;
    }

    chat(mobile, name) {
        const hello = `Hello${name ? ` ${name}` : ''}, thank you for shopping with us!`;
        openUrl(this, whatsappUrl(mobile, hello));
    }

    handleChat(event) {
        const { mobile, name } = event.currentTarget.dataset;
        this.chat(mobile, name);
    }

    handleRowAction(event) {
        if (event.detail.action.name === 'chat') {
            this.chat(event.detail.row.m, event.detail.row.n);
        }
    }

    get visibleCustomers() {
        let list = this.customers;
        if (this.filter === 'due') {
            list = list.filter((c) => c.du > 0);
        } else if (this.filter === 'top') {
            list = [...list].sort((a, b) => b.s - a.s).slice(0, 50);
        }
        if (this.search) {
            list = list.filter((c) => `${c.m} ${c.n}`.toLowerCase().includes(this.search));
        }
        return list.map((c) => ({
            ...c,
            displayName: c.n || 'Unnamed customer',
            initials: initials(c.n),
            stats: `${c.v} visit${c.v === 1 ? '' : 's'} · ${moneyShort(c.s)} · ${c.pt} pts`,
            hasDue: c.du > 0,
            dueText: money(c.du),
            telUrl: `tel:${c.m}`
        }));
    }

    get hasCustomers() {
        return this.visibleCustomers.length > 0;
    }

    get countText() {
        const total = this.customers.length;
        const due = this.customers.reduce((t, c) => t + c.du, 0);
        const dueText = due > 0 ? ` · ${money(due)} credit outstanding` : '';
        return `${total} customer${total === 1 ? '' : 's'}${dueText}`;
    }
}
