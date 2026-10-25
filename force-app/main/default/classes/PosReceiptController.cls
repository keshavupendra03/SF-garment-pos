/**
 * Renders one bill from its day file as a printable 80mm receipt.
 * URL: /apex/PosReceipt?d=yyyyMMdd&no=<bill no>
 */
public with sharing class PosReceiptController {
    public POS_Store__c store { get; private set; }
    public String errorMessage { get; private set; }
    public String billNo { get; private set; }
    public String billDate { get; private set; }
    public String billTime { get; private set; }
    public String customerName { get; private set; }
    public String customerMobile { get; private set; }
    public String cashier { get; private set; }
    public Decimal itemCount { get; private set; }
    public Decimal subTotal { get; private set; }
    public Decimal discount { get; private set; }
    public Decimal taxTotal { get; private set; }
    public Decimal roundOff { get; private set; }
    public Decimal grandTotal { get; private set; }
    public Decimal change { get; private set; }
    public Decimal creditDue { get; private set; }
    public Decimal points { get; private set; }
    public Boolean isCreditNote { get; private set; }
    public String docTitle { get; private set; }
    public String refBillNo { get; private set; }
    public String refBillDate { get; private set; }
    public String returnReason { get; private set; }
    public Decimal noteBalance { get; private set; }
    public String payVerb { get; private set; }
    public List<Line> lines { get; private set; }
    public List<Payment> payments { get; private set; }
    public List<TaxRow> taxRows { get; private set; }

    public class Line {
        public String name { get; set; }
        public String detail { get; set; }
        public Decimal qty { get; set; }
        public Decimal price { get; set; }
        public Decimal amount { get; set; }
    }

    public class Payment {
        public String mode { get; set; }
        public Decimal amount { get; set; }
    }

    public class TaxRow {
        public Decimal rate { get; set; }
        public Decimal taxable { get; set; }
        public Decimal cgst { get; set; }
        public Decimal sgst { get; set; }
    }

    public PosReceiptController() {
        lines = new List<Line>();
        payments = new List<Payment>();
        taxRows = new List<TaxRow>();

        Map<String, String> params = ApexPages.currentPage().getParameters();
        String day = params.get('d');
        String no = params.get('no');
        if (String.isBlank(day) || !Pattern.matches('[0-9]{8}', day) || String.isBlank(no)) {
            errorMessage = 'Missing or invalid bill reference.';
            return;
        }
        store = PosStorage.findStore();
        if (store == null) {
            errorMessage = 'Store is not set up yet.';
            return;
        }
        Map<String, Object> bill = findBill(PosStorage.readText(store.Id, 'B-' + day + '.ndjson'), no);
        if (bill == null) {
            errorMessage = 'Bill ' + no + ' was not found.';
            return;
        }
        load(bill);
    }

    private static Map<String, Object> findBill(String text, String no) {
        if (String.isBlank(text)) {
            return null;
        }
        String marker = '"no":' + JSON.serialize(no);
        for (String line : text.split('\n')) {
            if (line.contains(marker)) {
                return (Map<String, Object>) JSON.deserializeUntyped(line);
            }
        }
        return null;
    }

    private void load(Map<String, Object> bill) {
        isCreditNote = 'CN'.equals(bill.get('k'));
        docTitle = isCreditNote ? 'CREDIT NOTE' : 'TAX INVOICE';
        payVerb = isCreditNote ? 'Refunded' : 'Paid';
        refBillNo = (String) bill.get('ref');
        refBillDate = (String) bill.get('rdt');
        returnReason = (String) bill.get('rsn');
        noteBalance = dec(bill.get('bal'));
        billNo = (String) bill.get('no');
        billDate = (String) bill.get('dt');
        billTime = (String) bill.get('tm');
        cashier = (String) bill.get('by');
        subTotal = dec(bill.get('sub'));
        discount = dec(bill.get('dis'));
        taxTotal = dec(bill.get('tx'));
        roundOff = dec(bill.get('ro'));
        grandTotal = dec(bill.get('g'));
        change = dec(bill.get('chg'));
        creditDue = dec(bill.get('due'));
        points = dec(bill.get('pts'));

        Map<String, Object> cu = (Map<String, Object>) bill.get('cu');
        if (cu != null) {
            customerMobile = (String) cu.get('m');
            customerName = (String) cu.get('n');
        }

        itemCount = 0;
        Map<Decimal, TaxRow> byRate = new Map<Decimal, TaxRow>();
        for (Object o : (List<Object>) bill.get('l')) {
            Map<String, Object> l = (Map<String, Object>) o;
            Line line = new Line();
            line.name = (String) l.get('n');
            List<String> detail = new List<String>();
            for (String key : new List<String>{ 's', 'z', 'c' }) {
                if (String.isNotBlank((String) l.get(key))) {
                    detail.add((String) l.get(key));
                }
            }
            line.detail = String.join(detail, ' / ');
            line.qty = dec(l.get('q'));
            line.price = dec(l.get('p'));
            line.amount = dec(l.get('net'));
            lines.add(line);
            itemCount += line.qty;

            Decimal rate = dec(l.get('r'));
            Decimal lineTax = dec(l.get('tx'));
            TaxRow row = byRate.get(rate);
            if (row == null) {
                row = new TaxRow();
                row.rate = rate;
                row.taxable = 0;
                row.cgst = 0;
                byRate.put(rate, row);
            }
            row.taxable += line.amount - lineTax;
            row.cgst += lineTax;
        }
        for (TaxRow row : byRate.values()) {
            Decimal total = row.cgst;
            row.cgst = PosBillCalc.r2(total / 2);
            row.sgst = total - row.cgst;
            taxRows.add(row);
        }

        for (Object o : (List<Object>) bill.get('pay')) {
            Map<String, Object> p = (Map<String, Object>) o;
            Payment pay = new Payment();
            String mode = (String) p.get('m');
            pay.mode = mode == 'CN' ? 'Credit note ' + p.get('ref') : mode == 'DUE' ? 'Adjusted in dues' : mode;
            pay.amount = dec(p.get('a'));
            payments.add(pay);
        }
    }

    private static Decimal dec(Object value) {
        return PosStorage.toDecimal(value);
    }
}
