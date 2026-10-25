/**
 * Catalog and store management for the POS (Products tab and Store settings).
 * A "style" is every POS_Product__c sharing Name + Brand; each record is one size/color variant.
 */
public with sharing class PosAdminController {
    private static final String GSTIN_PATTERN = '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]';
    // EAN-13 prefix 20-29 is reserved for in-store numbering, so generated codes never clash with brand barcodes.
    private static final String BARCODE_PREFIX = '20';

    public class StyleInput {
        public String name;
        public String brand;
        public String category;
        public String hsn;
        public Decimal mrp;
        public Decimal price;
        public Decimal cost;
        public List<VariantInput> variants;
    }

    public class VariantInput {
        public Id id;
        public String size;
        public String color;
        public Decimal stock; // opening stock for a new variant
        public Decimal addStock; // stock received for an existing variant
        public Boolean active;
    }

    @AuraEnabled
    public static List<POS_Product__c> getProducts() {
        return [
            SELECT Id, Name, SKU__c, Barcode__c, Category__c, Brand__c, Size__c, Color__c,
                MRP__c, Price__c, Cost__c, HSN__c, Stock__c, Active__c
            FROM POS_Product__c
            ORDER BY Name, Color__c, Size__c
            LIMIT 5000
        ];
    }

    @AuraEnabled
    public static List<POS_Product__c> saveStyle(String styleJson) {
        StyleInput input;
        try {
            input = (StyleInput) JSON.deserialize(styleJson, StyleInput.class);
        } catch (Exception e) {
            throw fail('Invalid product data.');
        }
        if (input == null || String.isBlank(input.name)) {
            throw fail('Product name is required.');
        }
        if (input.price == null || input.price <= 0) {
            throw fail('Selling price must be more than zero.');
        }
        if (input.mrp != null && input.mrp < input.price) {
            throw fail('MRP cannot be lower than the selling price.');
        }
        if (input.variants == null || input.variants.isEmpty()) {
            throw fail('Add at least one size or color.');
        }

        Set<Id> ids = new Set<Id>();
        for (VariantInput v : input.variants) {
            if (v.id != null) {
                ids.add(v.id);
            }
        }
        Map<Id, POS_Product__c> existing = new Map<Id, POS_Product__c>([
            SELECT Id, Stock__c, SKU__c, Barcode__c FROM POS_Product__c WHERE Id IN :ids FOR UPDATE
        ]);
        Set<String> usedSkus = new Set<String>();
        for (POS_Product__c p : [SELECT SKU__c FROM POS_Product__c WHERE SKU__c != NULL LIMIT 10000]) {
            usedSkus.add(p.SKU__c.toUpperCase());
        }
        Long nextBarcode = nextBarcodeSeq();

        String name = input.name.trim().left(80);
        List<POS_Product__c> records = new List<POS_Product__c>();
        for (VariantInput v : input.variants) {
            POS_Product__c p;
            if (v.id != null) {
                p = existing.get(v.id);
                if (p == null) {
                    throw fail('One of the variants was deleted by someone else. Reload and try again.');
                }
                Decimal added = v.addStock == null ? 0 : v.addStock;
                p.Stock__c = (p.Stock__c == null ? 0 : p.Stock__c) + added;
            } else {
                p = new POS_Product__c(
                    Size__c = blankToNull(v.size),
                    Color__c = blankToNull(v.color),
                    Stock__c = v.stock == null || v.stock < 0 ? 0 : v.stock
                );
                p.SKU__c = uniqueSku(name, p.Color__c, p.Size__c, usedSkus);
                p.Barcode__c = ean13(nextBarcode++);
            }
            p.Name = name;
            p.Brand__c = blankToNull(input.brand);
            p.Category__c = blankToNull(input.category);
            p.HSN__c = blankToNull(input.hsn);
            p.MRP__c = input.mrp;
            p.Price__c = input.price;
            p.Cost__c = input.cost;
            p.Active__c = v.active != false;
            records.add(p);
        }

        try {
            upsert records;
        } catch (DmlException e) {
            throw fail(e.getDmlMessage(0));
        }
        Set<Id> savedIds = new Map<Id, POS_Product__c>(records).keySet();
        return [
            SELECT Id, Name, SKU__c, Barcode__c, Category__c, Brand__c, Size__c, Color__c,
                MRP__c, Price__c, Cost__c, HSN__c, Stock__c, Active__c
            FROM POS_Product__c
            WHERE Id IN :savedIds
        ];
    }

    @AuraEnabled
    public static Decimal adjustStock(Id productId, Decimal delta) {
        if (productId == null || delta == null) {
            throw fail('Missing product or quantity.');
        }
        List<POS_Product__c> rows = [SELECT Id, Stock__c FROM POS_Product__c WHERE Id = :productId FOR UPDATE];
        if (rows.isEmpty()) {
            throw fail('This product no longer exists.');
        }
        POS_Product__c p = rows[0];
        p.Stock__c = (p.Stock__c == null ? 0 : p.Stock__c) + delta;
        update p;
        return p.Stock__c;
    }

    @AuraEnabled
    public static void setActive(List<Id> productIds, Boolean active) {
        List<POS_Product__c> rows = new List<POS_Product__c>();
        for (Id productId : productIds) {
            rows.add(new POS_Product__c(Id = productId, Active__c = active == true));
        }
        update rows;
    }

    /** Gives every listed product that has no barcode a new in-store EAN-13. */
    @AuraEnabled
    public static List<POS_Product__c> assignBarcodes(List<Id> productIds) {
        List<POS_Product__c> missing = [
            SELECT Id, Barcode__c FROM POS_Product__c WHERE Id IN :productIds AND Barcode__c = NULL FOR UPDATE
        ];
        Long next = nextBarcodeSeq();
        for (POS_Product__c p : missing) {
            p.Barcode__c = ean13(next++);
        }
        try {
            update missing;
        } catch (DmlException e) {
            throw fail(e.getDmlMessage(0));
        }
        return [
            SELECT Id, Name, SKU__c, Barcode__c, Category__c, Brand__c, Size__c, Color__c,
                MRP__c, Price__c, Cost__c, HSN__c, Stock__c, Active__c
            FROM POS_Product__c
            WHERE Id IN :productIds
        ];
    }

    /** Sets a product's barcode to a value the shop already uses (e.g. the brand's printed code). */
    @AuraEnabled
    public static POS_Product__c setBarcode(Id productId, String barcode) {
        String value = PosStorage.cleanCode(barcode);
        if (String.isBlank(value)) {
            throw fail('Enter a barcode.');
        }
        if (value.length() > 40 || !Pattern.matches('[\\x20-\\x7E]+', value)) {
            throw fail('Barcode must be up to 40 English letters, digits or symbols.');
        }
        List<POS_Product__c> clash = [
            SELECT Name, Size__c, Color__c FROM POS_Product__c WHERE Barcode__c = :value AND Id != :productId LIMIT 1
        ];
        if (!clash.isEmpty()) {
            POS_Product__c other = clash[0];
            List<String> variant = new List<String>();
            for (String part : new List<String>{ other.Size__c, other.Color__c }) {
                if (String.isNotBlank(part)) {
                    variant.add(part);
                }
            }
            throw fail('This barcode is already used by ' + other.Name + (variant.isEmpty() ? '' : ' (' + String.join(variant, ' / ') + ')') + '.');
        }
        POS_Product__c p = new POS_Product__c(Id = productId, Barcode__c = value);
        try {
            update p;
        } catch (DmlException e) {
            throw fail(e.getDmlMessage(0));
        }
        return [
            SELECT Id, Name, SKU__c, Barcode__c, Category__c, Brand__c, Size__c, Color__c,
                MRP__c, Price__c, Cost__c, HSN__c, Stock__c, Active__c
            FROM POS_Product__c
            WHERE Id = :productId
        ];
    }

    @AuraEnabled
    public static POS_Store__c saveStore(String storeJson) {
        Map<String, Object> input;
        try {
            input = (Map<String, Object>) JSON.deserializeUntyped(storeJson);
        } catch (Exception e) {
            throw fail('Invalid store data.');
        }
        String name = text(input, 'Name');
        if (String.isBlank(name)) {
            throw fail('Shop name is required.');
        }
        String gstin = text(input, 'GSTIN__c');
        gstin = gstin == null ? null : gstin.trim().toUpperCase();
        if (String.isNotBlank(gstin) && !Pattern.matches(GSTIN_PATTERN, gstin)) {
            throw fail('GSTIN should be 15 characters, like 08ABCDE1234F1Z5.');
        }
        Decimal low = number(input, 'Tax_Rate_Low__c');
        Decimal high = number(input, 'Tax_Rate_High__c');
        Decimal threshold = number(input, 'Tax_Threshold__c');
        Decimal points = number(input, 'Points_Per_100__c');
        if (low == null || high == null || low < 0 || high < 0 || low > 100 || high > 100) {
            throw fail('GST rates must be between 0 and 100%.');
        }
        if (threshold == null || threshold < 0) {
            throw fail('GST threshold cannot be negative.');
        }
        if (points != null && points < 0) {
            throw fail('Loyalty points cannot be negative.');
        }
        String tz = String.isBlank(text(input, 'Time_Zone__c')) ? PosStorage.DEFAULT_TIME_ZONE : text(input, 'Time_Zone__c').trim();
        if (!PosStorage.isValidTimeZone(tz)) {
            throw fail('Unknown time zone: ' + tz);
        }

        // Lock the store row so this never races a bill save (which updates the bill counter).
        POS_Store__c store = PosStorage.getStore(true);
        store.Name = name.trim().left(80);
        store.GSTIN__c = blankToNull(gstin);
        store.Phone__c = blankToNull(text(input, 'Phone__c'));
        store.Address__c = blankToNull(text(input, 'Address__c'));
        store.Receipt_Footer__c = blankToNull(text(input, 'Receipt_Footer__c'));
        store.Bill_Prefix__c = String.isBlank(text(input, 'Bill_Prefix__c')) ? '' : text(input, 'Bill_Prefix__c').trim().left(10);
        store.Tax_Rate_Low__c = low;
        store.Tax_Rate_High__c = high;
        store.Tax_Threshold__c = threshold;
        store.Points_Per_100__c = points == null ? 0 : points;
        store.Time_Zone__c = tz;
        Decimal returnDays = number(input, 'Return_Days__c');
        if (returnDays != null && (returnDays < 0 || returnDays > 365)) {
            throw fail('Return window must be between 0 and 365 days.');
        }
        store.Return_Days__c = returnDays == null ? 7 : returnDays.round(System.RoundingMode.DOWN);
        update store;
        return PosStorage.findStore();
    }

    // ---------- helpers ----------

    @TestVisible
    private static String ean13(Long seq) {
        String body = BARCODE_PREFIX + String.valueOf(seq).leftPad(10, '0');
        Integer sum = 0;
        for (Integer i = 0; i < 12; i++) {
            Integer digit = Integer.valueOf(body.substring(i, i + 1));
            sum += Math.mod(i, 2) == 0 ? digit : digit * 3;
        }
        return body + String.valueOf(Math.mod(10 - Math.mod(sum, 10), 10));
    }

    private static Long nextBarcodeSeq() {
        Long maxSeq = 0;
        String prefix = BARCODE_PREFIX + '%';
        for (POS_Product__c p : [
            SELECT Barcode__c FROM POS_Product__c WHERE Barcode__c LIKE :prefix ORDER BY Barcode__c DESC LIMIT 200
        ]) {
            String b = p.Barcode__c;
            if (b.length() == 13 && b.isNumeric()) {
                maxSeq = Math.max(maxSeq, Long.valueOf(b.substring(2, 12)));
            }
        }
        return maxSeq + 1;
    }

    @TestVisible
    private static String uniqueSku(String name, String color, String size, Set<String> used) {
        List<String> words = name.toUpperCase().replaceAll('[^A-Z0-9 ]', ' ').normalizeSpace().split(' ');
        String code = '';
        if (words.size() == 1) {
            code = words[0].left(3);
        } else {
            for (Integer i = 0; i < words.size() && code.length() < 3; i++) {
                code += words[i].left(1);
            }
        }
        List<String> parts = new List<String>{ String.isBlank(code) ? 'SKU' : code };
        if (String.isNotBlank(color)) {
            parts.add(color.toUpperCase().replaceAll('[^A-Z0-9]', '').left(3));
        }
        if (String.isNotBlank(size)) {
            parts.add(size.toUpperCase().replaceAll('[^A-Z0-9]', '').left(6));
        }
        String base = String.join(parts, '-');
        String sku = base;
        Integer n = 2;
        while (used.contains(sku)) {
            sku = base + '-' + n++;
        }
        used.add(sku);
        return sku;
    }

    private static String blankToNull(String value) {
        return String.isBlank(value) ? null : value.trim();
    }

    private static String text(Map<String, Object> input, String key) {
        Object value = input.get(key);
        return value == null ? null : String.valueOf(value);
    }

    private static Decimal number(Map<String, Object> input, String key) {
        Object value = input.get(key);
        if (value == null || String.valueOf(value) == '') {
            return null;
        }
        try {
            return Decimal.valueOf(String.valueOf(value));
        } catch (Exception e) {
            throw fail('Enter a valid number for ' + key.replace('__c', '').replace('_', ' ') + '.');
        }
    }

    private static AuraHandledException fail(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message);
        return e;
    }
}
