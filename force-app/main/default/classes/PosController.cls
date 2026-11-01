/**
 * Apex API for the Garment POS LWCs. Products and settings are records; bills and
 * customers are JSON files handled through PosStorage.
 */
public with sharing class PosController {
    private static final Integer MAX_REPORT_DAYS = 92;
    private static final String MOBILE_PATTERN = '[0-9]{10}';

    public class BillInput {
        public String mobile;
        public String customerName;
        public List<LineInput> lines;
        public Decimal billDiscount;
        public List<PaymentInput> payments;
    }

    public class LineInput {
        public Id id;
        public Decimal q;
        public Decimal dp; // item discount in %
        public Decimal da; // item discount in rupees for the whole line (only one of dp / da)
        public Decimal price; // price per piece agreed at the counter; null = product price
    }

    public class PaymentInput {
        public String m;
        public Decimal a;
        public String ref;
    }

    @AuraEnabled
    public static Map<String, Object> getBootstrap() {
        try {
            POS_Store__c store = PosStorage.getStore(false);
            List<POS_Product__c> products = [
                SELECT Id, Name, SKU__c, Barcode__c, Category__c, Brand__c, Size__c, Color__c,
                    MRP__c, Price__c, HSN__c, Stock__c
                FROM POS_Product__c
                WHERE Active__c = TRUE
                ORDER BY Name, Size__c
                LIMIT 5000
            ];
            return new Map<String, Object>{ 'store' => store, 'products' => products };
        } catch (Exception e) {
            throw fail(e.getMessage());
        }
    }

    // Not cacheable: store details change from the Settings tab and must show up right away.
    @AuraEnabled
    public static POS_Store__c getStoreInfo() {
        return PosStorage.findStore();
    }

    @AuraEnabled
    public static Map<String, Object> saveBill(String billJson) {
        BillInput input;
        try {
            input = (BillInput) JSON.deserialize(billJson, BillInput.class);
        } catch (Exception e) {
            throw fail('Invalid bill data.');
        }
        if (input == null || input.lines == null || input.lines.isEmpty()) {
            throw fail('Add at least one item to the bill.');
        }
        String mobile = String.isBlank(input.mobile) ? null : input.mobile.trim();
        if (mobile != null && !Pattern.matches(MOBILE_PATTERN, mobile)) {
            throw fail('Mobile number must be 10 digits.');
        }
        Set<Id> productIds = new Set<Id>();
        for (LineInput li : input.lines) {
            if (li.id == null || li.q == null || li.q < 1 || li.q != li.q.round(System.RoundingMode.DOWN)) {
                throw fail('Each item needs a whole-number quantity of at least 1.');
            }
            if (productIds.contains(li.id)) {
                throw fail('The same product appears twice on the bill.');
            }
            productIds.add(li.id);
        }

        Savepoint sp = Database.setSavepoint();
        try {
            // Row lock on the store serializes every bill save: counter, stock and JSON files stay consistent.
            POS_Store__c store = PosStorage.getStore(true);
            Map<Id, POS_Product__c> products = new Map<Id, POS_Product__c>([
                SELECT Id, Name, SKU__c, Size__c, Color__c, HSN__c, Price__c, Stock__c
                FROM POS_Product__c
                WHERE Id IN :productIds
                FOR UPDATE
            ]);

            Map<String, Object> bill = PosBillCalc.compute(store, products, input, mobile);

            Datetime now = Datetime.now();
            Decimal billNo = store.Next_Bill_No__c == null ? 1 : store.Next_Bill_No__c;
            String prefix = store.Bill_Prefix__c == null ? '' : store.Bill_Prefix__c;
            Decimal grand = (Decimal) bill.get('g');
            Decimal pointsPer100 = store.Points_Per_100__c == null ? 0 : store.Points_Per_100__c;
            Decimal points = (grand / 100).round(System.RoundingMode.DOWN) * pointsPer100;

            bill.put('no', prefix + String.valueOf(billNo.longValue()).leftPad(6, '0'));
            String tz = PosStorage.timeZoneOf(store);
            bill.put('dt', now.format('yyyy-MM-dd', tz));
            bill.put('tm', now.format('HH:mm', tz));
            bill.put('ts', now.getTime());
            bill.put('by', UserInfo.getName());
            bill.put('pts', mobile == null ? 0 : points);

            if (mobile != null) {
                bill.put('cu', saveCustomerVisit(store.Id, mobile, input.customerName, bill, points));
            }
            redeemCreditNotes(store.Id, (List<Object>) bill.get('pay'));

            for (LineInput li : input.lines) {
                POS_Product__c p = products.get(li.id);
                p.Stock__c = (p.Stock__c == null ? 0 : p.Stock__c) - li.q;
            }
            update products.values();

            store.Next_Bill_No__c = billNo + 1;
            update store;

            PosStorage.appendLine(store.Id, PosStorage.billFileFor(now.format('yyyyMMdd', tz)), JSON.serialize(bill));
            return bill;
        } catch (PosBillCalc.CalcException e) {
            Database.rollback(sp);
            throw fail(e.getMessage());
        } catch (Exception e) {
            Database.rollback(sp);
            throw fail('Could not save the bill: ' + e.getMessage());
        }
    }

    /** Deducts credit-note payments from the open notes file (caller holds the store lock). */
    private static void redeemCreditNotes(Id storeId, List<Object> pays) {
        Map<String, Object> notes;
        for (Object o : pays) {
            Map<String, Object> pay = (Map<String, Object>) o;
            if (!'CN'.equals(pay.get('m'))) {
                continue;
            }
            if (notes == null) {
                notes = PosStorage.readJsonMap(storeId, PosStorage.OPEN_NOTES_FILE);
            }
            String ref = (String) pay.get('ref');
            Map<String, Object> note = (Map<String, Object>) notes.get(ref);
            if (note == null) {
                throw new PosBillCalc.CalcException('Credit note ' + ref + ' is not open or was already used.');
            }
            Decimal amount = (Decimal) pay.get('a');
            Decimal balance = PosStorage.toDecimal(note.get('bal'));
            if (amount > balance) {
                throw new PosBillCalc.CalcException('Credit note ' + ref + ' has only ₹' + balance.format() + ' left.');
            }
            balance -= amount;
            if (balance <= 0) {
                notes.remove(ref);
            } else {
                note.put('bal', balance);
            }
        }
        if (notes != null) {
            PosStorage.writeText(storeId, PosStorage.OPEN_NOTES_FILE, JSON.serialize(notes));
        }
    }

    private static Map<String, Object> saveCustomerVisit(
        Id storeId,
        String mobile,
        String customerName,
        Map<String, Object> bill,
        Decimal points
    ) {
        Map<String, Object> customers = PosStorage.readCustomers(storeId, mobile);
        Map<String, Object> c = customers.containsKey(mobile)
            ? (Map<String, Object>) customers.get(mobile)
            : new Map<String, Object>{ 'f' => bill.get('dt'), 'v' => 0, 's' => 0, 'pt' => 0, 'du' => 0 };
        if (String.isNotBlank(customerName)) {
            c.put('n', customerName.trim().left(80));
        }
        c.put('v', PosStorage.toDecimal(c.get('v')) + 1);
        c.put('s', PosStorage.toDecimal(c.get('s')) + (Decimal) bill.get('g'));
        c.put('pt', PosStorage.toDecimal(c.get('pt')) + points);
        c.put('du', PosStorage.toDecimal(c.get('du')) + (Decimal) bill.get('due'));
        c.put('l', bill.get('dt'));
        customers.put(mobile, c);
        PosStorage.writeText(storeId, PosStorage.customerFile(mobile), JSON.serialize(customers));
        return new Map<String, Object>{ 'm' => mobile, 'n' => c.get('n') };
    }

    @AuraEnabled
    public static Map<String, Object> findCustomer(String mobile) {
        if (String.isBlank(mobile) || !Pattern.matches(MOBILE_PATTERN, mobile)) {
            throw fail('Mobile number must be 10 digits.');
        }
        POS_Store__c store = PosStorage.findStore();
        if (store == null) {
            return null;
        }
        Map<String, Object> c = (Map<String, Object>) PosStorage.readCustomers(store.Id, mobile).get(mobile);
        if (c != null) {
            c.put('m', mobile);
        }
        return c;
    }

    /** Raw customer shard files; the LWC parses and merges them. */
    @AuraEnabled
    public static List<String> getCustomers() {
        POS_Store__c store = PosStorage.findStore();
        if (store == null) {
            return new List<String>();
        }
        return PosStorage.readMany(store.Id, PosStorage.allCustomerFiles()).values();
    }

    /** NDJSON of every bill between the two dates (yyyy-MM-dd, inclusive), oldest first. */
    @AuraEnabled
    public static String getBills(String fromDate, String toDate) {
        Date fromD;
        Date toD;
        try {
            fromD = Date.valueOf(fromDate);
            toD = Date.valueOf(toDate);
        } catch (Exception e) {
            throw fail('Pick a valid date range.');
        }
        if (fromD > toD) {
            throw fail('The start date must be on or before the end date.');
        }
        if (fromD.daysBetween(toD) > MAX_REPORT_DAYS) {
            throw fail('Pick a range of at most ' + MAX_REPORT_DAYS + ' days.');
        }
        POS_Store__c store = PosStorage.findStore();
        if (store == null) {
            return '';
        }
        Set<String> names = new Set<String>();
        for (Date d = fromD; d <= toD; d = d.addDays(1)) {
            names.add(PosStorage.billFile(d));
        }
        Map<String, String> files = PosStorage.readMany(store.Id, names);
        List<String> keys = new List<String>(files.keySet());
        keys.sort();
        List<String> parts = new List<String>();
        for (String k : keys) {
            parts.add(files.get(k));
        }
        return String.join(parts, '\n');
    }

    @AuraEnabled
    public static Map<String, Object> getStorageInfo() {
        POS_Store__c store = PosStorage.getStore(false);
        Integer files = 0;
        Long fileBytes = 0;
        Long billBytes = 0;
        Long customerBytes = 0;
        for (Attachment a : [SELECT Name, BodyLength FROM Attachment WHERE ParentId = :store.Id]) {
            Long size = a.BodyLength == null ? 0 : a.BodyLength;
            files++;
            fileBytes += size;
            if (a.Name.startsWith('B-')) {
                billBytes += size;
            } else if (a.Name.startsWith('C-')) {
                customerBytes += size;
            }
        }
        Integer records = [SELECT COUNT() FROM POS_Product__c] + [SELECT COUNT() FROM POS_Store__c];
        return new Map<String, Object>{
            'files' => files,
            'fileBytes' => fileBytes,
            'billBytes' => billBytes,
            'customerBytes' => customerBytes,
            'fileLimit' => PosStorage.FILE_STORAGE_LIMIT,
            'records' => records,
            'recordBytes' => records * PosStorage.BYTES_PER_RECORD,
            'dataLimit' => PosStorage.DATA_STORAGE_LIMIT
        };
    }

    private static AuraHandledException fail(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message);
        return e;
    }
}
