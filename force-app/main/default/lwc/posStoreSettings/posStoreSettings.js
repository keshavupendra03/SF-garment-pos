import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getStoreInfo from '@salesforce/apex/PosController.getStoreInfo';
import saveStore from '@salesforce/apex/PosAdminController.saveStore';
import { errorMessage, num } from 'c/posUtils';

const FIELDS = [
    'Name',
    'Phone__c',
    'GSTIN__c',
    'Address__c',
    'Receipt_Footer__c',
    'Bill_Prefix__c',
    'Tax_Threshold__c',
    'Tax_Rate_Low__c',
    'Tax_Rate_High__c',
    'Points_Per_100__c',
    'Time_Zone__c',
    'Return_Days__c'
];

const TIME_ZONES = [
    { label: 'India (IST)', value: 'Asia/Kolkata' },
    { label: 'Nepal', value: 'Asia/Kathmandu' },
    { label: 'Bangladesh', value: 'Asia/Dhaka' },
    { label: 'Sri Lanka', value: 'Asia/Colombo' },
    { label: 'Pakistan', value: 'Asia/Karachi' },
    { label: 'UAE (Gulf)', value: 'Asia/Dubai' },
    { label: 'Singapore', value: 'Asia/Singapore' },
    { label: 'UK', value: 'Europe/London' },
    { label: 'US Eastern', value: 'America/New_York' },
    { label: 'US Pacific', value: 'America/Los_Angeles' }
];

const NUMERIC = new Set(['Tax_Threshold__c', 'Tax_Rate_Low__c', 'Tax_Rate_High__c', 'Points_Per_100__c', 'Return_Days__c']);

const DEFAULTS = {
    Name: 'My Garment Store',
    Bill_Prefix__c: 'INV-',
    Tax_Threshold__c: 2500,
    Tax_Rate_Low__c: 5,
    Tax_Rate_High__c: 18,
    Points_Per_100__c: 1,
    Time_Zone__c: 'Asia/Kolkata',
    Return_Days__c: 7
};

function pick(store) {
    const form = {};
    FIELDS.forEach((f) => {
        const value = store ? store[f] : undefined;
        form[f] = value === undefined || value === null ? DEFAULTS[f] ?? '' : value;
    });
    return form;
}

export default class PosStoreSettings extends LightningElement {
    form = pick(null);
    original = pick(null);
    nextBillNo;
    loading = true;
    saving = false;
    error;

    connectedCallback() {
        this.load();
    }

    @api
    refresh() {
        if (!this.isDirty) {
            this.load();
        }
    }

    async load() {
        this.loading = true;
        try {
            const store = await getStoreInfo();
            this.form = pick(store);
            this.original = pick(store);
            this.nextBillNo = store ? store.Next_Bill_No__c : 1;
            this.error = undefined;
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.loading = false;
        }
    }

    get isDirty() {
        return JSON.stringify(this.form) !== JSON.stringify(this.original);
    }

    handleChange(event) {
        const field = event.target.dataset.field;
        let value = event.detail.value;
        if (field === 'GSTIN__c') {
            value = (value || '').toUpperCase();
        } else if (NUMERIC.has(field) && value !== '' && value !== null) {
            value = Number(value);
        }
        this.form = { ...this.form, [field]: value };
    }

    handleDiscard() {
        this.form = { ...this.original };
    }

    async handleSave() {
        const inputs = [...this.template.querySelectorAll('[data-field]')];
        const valid = inputs.reduce((ok, input) => input.reportValidity() && ok, true);
        if (!valid) {
            return;
        }
        this.saving = true;
        try {
            const store = await saveStore({ storeJson: JSON.stringify(this.form) });
            this.form = pick(store);
            this.original = pick(store);
            this.nextBillNo = store.Next_Bill_No__c;
            this.dispatchEvent(new ShowToastEvent({ title: 'Store details saved', variant: 'success' }));
        } catch (e) {
            this.dispatchEvent(new ShowToastEvent({ title: 'Could not save', message: errorMessage(e), variant: 'error' }));
        } finally {
            this.saving = false;
        }
    }

    get timeZoneOptions() {
        const current = this.form.Time_Zone__c;
        return TIME_ZONES.some((t) => t.value === current) ? TIME_ZONES : [...TIME_ZONES, { label: current, value: current }];
    }

    get saveLabel() {
        return this.saving ? 'Saving…' : 'Save changes';
    }

    get nextBillText() {
        const n = String(Math.max(1, num(this.nextBillNo, 1))).padStart(6, '0');
        return `${this.form.Bill_Prefix__c || ''}${n}`;
    }

    get slabText() {
        const f = this.form;
        return `Up to ₹${num(f.Tax_Threshold__c).toLocaleString('en-IN')} per piece (before GST): ${num(f.Tax_Rate_Low__c)}% · above: ${num(f.Tax_Rate_High__c)}%`;
    }

    get pointsText() {
        const p = num(this.form.Points_Per_100__c);
        return p > 0 ? `A ₹1,000 bill earns ${Math.floor(10 * p)} points.` : 'Loyalty points are off.';
    }

    // Receipt header preview, laid out like the 58mm printout.
    get preview() {
        const f = this.form;
        return {
            name: f.Name || 'Shop name',
            address: f.Address__c,
            phone: f.Phone__c ? `Ph: ${f.Phone__c}` : '',
            gstin: f.GSTIN__c ? `GSTIN: ${f.GSTIN__c}` : '',
            footer: f.Receipt_Footer__c || 'Thank you for shopping with us!'
        };
    }
}
