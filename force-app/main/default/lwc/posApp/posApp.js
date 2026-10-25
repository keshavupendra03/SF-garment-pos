import { LightningElement } from 'lwc';

const TABS = [
    { name: 'billing', label: 'Billing', icon: 'utility:cart' },
    { name: 'bills', label: 'Bills', icon: 'utility:list' },
    { name: 'products', label: 'Products', icon: 'utility:package' },
    { name: 'customers', label: 'Customers', icon: 'utility:groups' },
    { name: 'settings', label: 'Settings', icon: 'utility:settings' }
];

export default class PosApp extends LightningElement {
    active = 'billing';
    // Panes render on first visit and then stay mounted (hidden), so the open bill survives tab switches.
    visited = { billing: true };

    get tabs() {
        return TABS.map((t) => {
            const isActive = t.name === this.active;
            return {
                ...t,
                cls: `nav-btn${isActive ? ' nav-btn_active' : ''}`,
                current: isActive ? 'page' : 'false'
            };
        });
    }

    handleNav(event) {
        const name = event.currentTarget.dataset.name;
        if (name === this.active) {
            return;
        }
        const wasVisited = Boolean(this.visited[name]);
        this.active = name;
        this.visited = { ...this.visited, [name]: true };
        if (wasVisited) {
            const pane = this.template.querySelector(`c-pos-${name}`);
            if (pane && typeof pane.refresh === 'function') {
                pane.refresh();
            }
        }
    }

    // "Return / exchange" on a bill in the Bills tab opens the return wizard in Billing.
    handleStartReturn(event) {
        this.active = 'billing';
        const billing = this.template.querySelector('c-pos-billing');
        if (billing) {
            billing.startReturn(event.detail.query);
        }
    }

    paneClass(name) {
        return name === this.active ? 'pane' : 'pane pane_hidden';
    }

    get billingClass() {
        return this.paneClass('billing');
    }
    get billsClass() {
        return this.paneClass('bills');
    }
    get productsClass() {
        return this.paneClass('products');
    }
    get showProducts() {
        return Boolean(this.visited.products);
    }
    get customersClass() {
        return this.paneClass('customers');
    }
    get settingsClass() {
        return this.paneClass('settings');
    }
    get showBills() {
        return Boolean(this.visited.bills);
    }
    get showCustomers() {
        return Boolean(this.visited.customers);
    }
    get showSettings() {
        return Boolean(this.visited.settings);
    }
}
