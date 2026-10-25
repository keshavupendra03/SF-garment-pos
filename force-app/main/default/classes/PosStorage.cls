/**
 * JSON-in-Attachment storage for the POS.
 *
 * All data files are Attachments parented to the single POS_Store__c record:
 *   B-yyyyMMdd.ndjson  one bill per line, one file per day (append-only)
 *   C-<d>.json         customers keyed by mobile, sharded by the mobile's last digit
 *   N-open.json        credit notes with balance left, keyed by credit note number
 *
 * Day files hold sales bills and credit notes (returns, "k":"CN") side by side.
 *
 * Writers must hold the store row lock (getStore(true)) so concurrent counters
 * never overwrite each other's changes.
 */
public with sharing class PosStorage {
    public static final Integer FILE_STORAGE_LIMIT = 20 * 1024 * 1024;
    public static final Integer DATA_STORAGE_LIMIT = 5 * 1024 * 1024;
    public static final Integer BYTES_PER_RECORD = 2048;
    public static final Integer CUSTOMER_SHARDS = 10;
    public static final String DEFAULT_TIME_ZONE = 'Asia/Kolkata';
    public static final String OPEN_NOTES_FILE = 'N-open.json';

    public static POS_Store__c findStore() {
        List<POS_Store__c> stores = [SELECT Id FROM POS_Store__c ORDER BY CreatedDate LIMIT 1];
        return stores.isEmpty() ? null : queryStore(stores[0].Id, false);
    }

    public static POS_Store__c getStore(Boolean forUpdate) {
        List<POS_Store__c> stores = [SELECT Id FROM POS_Store__c ORDER BY CreatedDate LIMIT 1];
        if (stores.isEmpty()) {
            POS_Store__c store = new POS_Store__c(
                Name = 'My Garment Store',
                Bill_Prefix__c = 'INV-',
                Next_Bill_No__c = 1,
                Tax_Threshold__c = 2500,
                Tax_Rate_Low__c = 5,
                Tax_Rate_High__c = 18,
                Points_Per_100__c = 1,
                Time_Zone__c = DEFAULT_TIME_ZONE,
                Next_Return_No__c = 1,
                Return_Days__c = 7
            );
            insert store;
            stores.add(store);
        }
        return queryStore(stores[0].Id, forUpdate);
    }

    private static POS_Store__c queryStore(Id storeId, Boolean forUpdate) {
        // ORDER BY is not allowed with FOR UPDATE, hence the lookup by Id.
        if (forUpdate) {
            return [
                SELECT Id, Name, GSTIN__c, Address__c, Phone__c, Bill_Prefix__c, Next_Bill_No__c,
                    Tax_Threshold__c, Tax_Rate_Low__c, Tax_Rate_High__c, Points_Per_100__c, Receipt_Footer__c, Time_Zone__c,
                    Next_Return_No__c, Return_Days__c
                FROM POS_Store__c WHERE Id = :storeId FOR UPDATE
            ];
        }
        return [
            SELECT Id, Name, GSTIN__c, Address__c, Phone__c, Bill_Prefix__c, Next_Bill_No__c,
                Tax_Threshold__c, Tax_Rate_Low__c, Tax_Rate_High__c, Points_Per_100__c, Receipt_Footer__c, Time_Zone__c,
                Next_Return_No__c, Return_Days__c
            FROM POS_Store__c WHERE Id = :storeId
        ];
    }

    /** Today's date in the shop's time zone. */
    public static Date todayFor(POS_Store__c store) {
        return Date.valueOf(Datetime.now().format('yyyy-MM-dd', timeZoneOf(store)));
    }

    /**
     * Cleans a scanned/typed code: scanners may add an AIM identifier ("]C1"), FNC1 (ASCII 29),
     * or a literal CODE128 code-set marker ("{B") printed by some printers.
     */
    public static String cleanCode(String raw) {
        return raw == null
            ? ''
            : raw.trim()
                  .replaceFirst('^\\][A-Za-z][0-9A-Za-z]', '')
                  .replace(String.fromCharArray(new List<Integer>{ 29 }), '')
                  .replaceFirst('^\\{[ABC]', '')
                  .trim();
    }

    public static Map<String, Object> readJsonMap(Id storeId, String name) {
        String text = readText(storeId, name);
        return String.isBlank(text) ? new Map<String, Object>() : (Map<String, Object>) JSON.deserializeUntyped(text);
    }

    /**
     * The shop's time zone. Bill dates and day files use it rather than the running user's
     * time zone, so every cashier (and the Bills tab) agrees on what "today" is.
     */
    public static String timeZoneOf(POS_Store__c store) {
        return store == null || String.isBlank(store.Time_Zone__c) ? DEFAULT_TIME_ZONE : store.Time_Zone__c;
    }

    public static Boolean isValidTimeZone(String tzId) {
        return String.isNotBlank(tzId) && TimeZone.getTimeZone(tzId).getID() == tzId;
    }

    public static String billFile(Date day) {
        // Midnight GMT formatted in GMT keeps the calendar date unchanged.
        return billFileFor(Datetime.newInstanceGmt(day, Time.newInstance(0, 0, 0, 0)).formatGmt('yyyyMMdd'));
    }

    public static String billFileFor(String yyyymmdd) {
        return 'B-' + yyyymmdd + '.ndjson';
    }

    public static String customerFile(String mobile) {
        return 'C-' + mobile.right(1) + '.json';
    }

    public static Set<String> allCustomerFiles() {
        Set<String> names = new Set<String>();
        for (Integer i = 0; i < CUSTOMER_SHARDS; i++) {
            names.add('C-' + i + '.json');
        }
        return names;
    }

    public static String readText(Id parentId, String name) {
        List<Attachment> files = [
            SELECT Body FROM Attachment WHERE ParentId = :parentId AND Name = :name ORDER BY CreatedDate LIMIT 1
        ];
        return files.isEmpty() ? null : files[0].Body.toString();
    }

    public static Map<String, String> readMany(Id parentId, Set<String> names) {
        Map<String, String> result = new Map<String, String>();
        for (Attachment f : [SELECT Name, Body FROM Attachment WHERE ParentId = :parentId AND Name IN :names]) {
            result.put(f.Name, f.Body.toString());
        }
        return result;
    }

    public static void writeText(Id parentId, String name, String content) {
        List<Attachment> files = [SELECT Id FROM Attachment WHERE ParentId = :parentId AND Name = :name LIMIT 1];
        Blob body = Blob.valueOf(content);
        if (files.isEmpty()) {
            insert new Attachment(ParentId = parentId, Name = name, Body = body, ContentType = 'application/json');
        } else {
            update new Attachment(Id = files[0].Id, Body = body);
        }
    }

    public static void appendLine(Id parentId, String name, String line) {
        String existing = readText(parentId, name);
        writeText(parentId, name, String.isBlank(existing) ? line : existing + '\n' + line);
    }

    public static Map<String, Object> readCustomers(Id storeId, String mobile) {
        String text = readText(storeId, customerFile(mobile));
        return String.isBlank(text) ? new Map<String, Object>() : (Map<String, Object>) JSON.deserializeUntyped(text);
    }

    public static Decimal toDecimal(Object value) {
        return value == null ? 0 : Decimal.valueOf(String.valueOf(value));
    }
}
