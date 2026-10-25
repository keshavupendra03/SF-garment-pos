@IsTest
private class PosAdminControllerTest {
    private static Map<String, Object> variant(Id id, String size, String color, Decimal stock, Decimal addStock, Boolean active) {
        return new Map<String, Object>{
            'id' => id,
            'size' => size,
            'color' => color,
            'stock' => stock,
            'addStock' => addStock,
            'active' => active
        };
    }

    private static String style(List<Object> variants) {
        return JSON.serialize(new Map<String, Object>{
            'name' => 'Slim Fit Jeans',
            'brand' => 'DenimCo',
            'category' => 'Jeans',
            'hsn' => '6203',
            'mrp' => 1999,
            'price' => 1699,
            'cost' => 800,
            'variants' => variants
        });
    }

    @IsTest
    static void ean13ChecksumIsValid() {
        Assert.areEqual('2000000000015', PosAdminController.ean13(1));
    }

    @IsTest
    static void skuIsShortAndUnique() {
        Set<String> used = new Set<String>{ 'SFJ-BLU-32' };
        Assert.areEqual('SFJ-BLU-32-2', PosAdminController.uniqueSku('Slim Fit Jeans', 'Blue', '32', used));
        Assert.areEqual('KUR', PosAdminController.uniqueSku('Kurta', null, null, used));
    }

    @IsTest
    static void createsVariantsThenEditsStyle() {
        List<POS_Product__c> created = PosAdminController.saveStyle(style(new List<Object>{
            variant(null, '30', 'Blue', 5, null, true),
            variant(null, '32', 'Blue', 3, null, true)
        }));
        Assert.areEqual(2, created.size());
        for (POS_Product__c p : created) {
            Assert.isTrue(p.Barcode__c.startsWith('20') && p.Barcode__c.length() == 13, p.Barcode__c);
            Assert.isTrue(p.SKU__c.startsWith('SFJ-BLU-'), p.SKU__c);
            Assert.areEqual(1699, p.Price__c);
        }

        Id first = created[0].Id;
        Id second = created[1].Id;
        Decimal firstStock = created[0].Stock__c;
        List<POS_Product__c> edited = PosAdminController.saveStyle(style(new List<Object>{
            variant(first, '30', 'Blue', null, 4, true),
            variant(second, '32', 'Blue', null, 0, false),
            variant(null, '34', 'Blue', 2, null, true)
        }));
        Assert.areEqual(3, edited.size());
        Map<Id, POS_Product__c> byId = new Map<Id, POS_Product__c>(edited);
        Assert.areEqual(firstStock + 4, byId.get(first).Stock__c);
        Assert.isFalse(byId.get(second).Active__c);
        Assert.areEqual(3, PosAdminController.getProducts().size());
    }

    @IsTest
    static void rejectsBadStyle() {
        try {
            PosAdminController.saveStyle(JSON.serialize(new Map<String, Object>{ 'name' => 'X', 'price' => 0 }));
            Assert.fail('Expected price validation');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('price'), e.getMessage());
        }
    }

    @IsTest
    static void adjustsStockAndActive() {
        POS_Product__c p = new POS_Product__c(Name = 'Tee', SKU__c = 'TEE-1', Price__c = 499, Stock__c = 5, Active__c = true);
        insert p;
        Assert.areEqual(8, PosAdminController.adjustStock(p.Id, 3));
        Assert.areEqual(6, PosAdminController.adjustStock(p.Id, -2));
        PosAdminController.setActive(new List<Id>{ p.Id }, false);
        Assert.isFalse([SELECT Active__c FROM POS_Product__c WHERE Id = :p.Id].Active__c);
    }

    @IsTest
    static void assignsAndSetsBarcodes() {
        POS_Product__c a = new POS_Product__c(Name = 'Tee', SKU__c = 'TEE-A', Price__c = 499, Active__c = true);
        POS_Product__c b = new POS_Product__c(Name = 'Tee', SKU__c = 'TEE-B', Price__c = 499, Active__c = true, Barcode__c = '8901234567');
        insert new List<POS_Product__c>{ a, b };

        List<POS_Product__c> result = PosAdminController.assignBarcodes(new List<Id>{ a.Id, b.Id });
        Map<Id, POS_Product__c> byId = new Map<Id, POS_Product__c>(result);
        Assert.areEqual('2000000000015', byId.get(a.Id).Barcode__c);
        Assert.areEqual('8901234567', byId.get(b.Id).Barcode__c, 'existing barcode must not change');

        Assert.areEqual('890100001', PosAdminController.setBarcode(a.Id, '{B890100001').Barcode__c, 'code-set marker stripped');
        Assert.areEqual('890100002', PosAdminController.setBarcode(a.Id, ']C1890100002').Barcode__c, 'AIM identifier stripped');
        Assert.areEqual('BRAND-001', PosAdminController.setBarcode(a.Id, ' BRAND-001 ').Barcode__c);
        try {
            PosAdminController.setBarcode(b.Id, 'BRAND-001');
            Assert.fail('Expected duplicate barcode error');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('already used'), e.getMessage());
        }
        try {
            PosAdminController.setBarcode(b.Id, '   ');
            Assert.fail('Expected blank barcode error');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('Enter a barcode'), e.getMessage());
        }
    }

    @IsTest
    static void savesStoreSettings() {
        Map<String, Object> input = new Map<String, Object>{
            'Name' => 'Shree Fashion',
            'GSTIN__c' => '08abcde1234f1z5',
            'Phone__c' => '9876500000',
            'Address__c' => 'MG Road, Jaipur',
            'Receipt_Footer__c' => 'Thank you!',
            'Bill_Prefix__c' => 'SF-',
            'Tax_Rate_Low__c' => 5,
            'Tax_Rate_High__c' => 18,
            'Tax_Threshold__c' => 2500,
            'Points_Per_100__c' => 2
        };
        POS_Store__c store = PosAdminController.saveStore(JSON.serialize(input));
        Assert.areEqual('Shree Fashion', store.Name);
        Assert.areEqual('08ABCDE1234F1Z5', store.GSTIN__c);
        Assert.areEqual('SF-', store.Bill_Prefix__c);

        Assert.areEqual('Asia/Kolkata', store.Time_Zone__c);

        input.put('Time_Zone__c', 'Mars/Olympus');
        try {
            PosAdminController.saveStore(JSON.serialize(input));
            Assert.fail('Expected time zone validation');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('time zone'), e.getMessage());
        }
        input.put('Time_Zone__c', 'Asia/Kolkata');

        input.put('GSTIN__c', 'BAD');
        try {
            PosAdminController.saveStore(JSON.serialize(input));
            Assert.fail('Expected GSTIN validation');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('GSTIN'), e.getMessage());
        }
    }
}
