import { LightningElement, api } from 'lwc';
import getStorageInfo from '@salesforce/apex/PosController.getStorageInfo';
import { errorMessage, formatBytes, num } from 'c/posUtils';

export default class PosStorage extends LightningElement {
    info;
    loading = false;
    error;

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
            this.info = await getStorageInfo();
            this.error = undefined;
        } catch (e) {
            this.error = errorMessage(e);
        } finally {
            this.loading = false;
        }
    }

    pct(used, limit) {
        return limit ? Math.min(100, Math.round((num(used) / num(limit)) * 1000) / 10) : 0;
    }

    meter(used, limit) {
        const value = this.pct(used, limit);
        const level = value >= 90 ? 'meter-fill_danger' : value >= 70 ? 'meter-fill_warn' : '';
        return { value, style: `width:${value}%`, cls: `meter-fill ${level}` };
    }

    get file() {
        const i = this.info;
        return i ? this.meter(i.fileBytes, i.fileLimit) : {};
    }

    get data() {
        const i = this.info;
        return i ? this.meter(i.recordBytes, i.dataLimit) : {};
    }

    get fileText() {
        const i = this.info;
        return i ? `${formatBytes(i.fileBytes)} of ${formatBytes(i.fileLimit)}` : '';
    }

    get dataText() {
        const i = this.info;
        return i ? `≈ ${formatBytes(i.recordBytes)} of ${formatBytes(i.dataLimit)}` : '';
    }

    get fileDetail() {
        const i = this.info;
        return i
            ? `${i.files} JSON files · bills ${formatBytes(i.billBytes)} · customers ${formatBytes(i.customerBytes)}`
            : '';
    }

    get dataDetail() {
        const i = this.info;
        return i ? `${i.records} records (products + store) at about 2 KB each` : '';
    }
}
