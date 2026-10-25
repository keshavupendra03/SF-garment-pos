// Garment POS smoke test: runs a real bill and a return end to end, then rolls everything back,
// so no data is left in the org. Prints SMOKE_TEST_PASSED when every check succeeds.
// Run: sf apex run --file scripts/apex/smoke-test.apex --target-org <alias>
Savepoint sp = Database.setSavepoint();
try {
    POS_Store__c store = PosStorage.getStore(false);
    System.assert(store != null, 'No POS Store record');

    POS_Product__c p = new POS_Product__c(
        Name = 'Smoke Test Tee',
        SKU__c = 'SMOKE-' + Math.abs(Crypto.getRandomInteger()),
        Price__c = 999,
        Stock__c = 5,
        Active__c = true
    );
    insert p;

    Map<String, Object> boot = PosController.getBootstrap();
    System.assert(boot.get('products') != null, 'Billing could not load products');

    Map<String, Object> bill = PosController.saveBill(JSON.serialize(new Map<String, Object>{
        'mobile' => '9000000000',
        'customerName' => 'Smoke Test',
        'billDiscount' => 0,
        'lines' => new List<Object>{ new Map<String, Object>{ 'id' => p.Id, 'q' => 2, 'dp' => 0 } },
        'payments' => new List<Object>{ new Map<String, Object>{ 'm' => 'CASH', 'a' => 2000 } }
    }));
    System.assertEquals(1998, (Decimal) bill.get('g'), 'Bill total');
    String day = (String) bill.get('dt');
    System.assert(PosController.getBills(day, day).contains((String) bill.get('no')), 'Bill was not stored');
    System.assert(PosController.findCustomer('9000000000') != null, 'Customer was not stored');

    Map<String, Object> note = PosReturnController.processReturn(JSON.serialize(new Map<String, Object>{
        'billNo' => bill.get('no'),
        'billDate' => day,
        'outcome' => 'credit',
        'lines' => new List<Object>{ new Map<String, Object>{ 'idx' => 0, 'q' => 1, 'restock' => true } }
    }));
    System.assertEquals(999, (Decimal) note.get('bal'), 'Credit note value');
    System.assertEquals(4, [SELECT Stock__c FROM POS_Product__c WHERE Id = :p.Id].Stock__c, 'Stock after sale and return');
    System.assert(PosReturnController.getCreditNote((String) note.get('no')) != null, 'Credit note is not open');

    PosController.getStorageInfo();
    PosAdminController.getProducts();
    System.debug(LoggingLevel.ERROR, 'SMOKE_TEST_PASSED bill=' + bill.get('no') + ' note=' + note.get('no'));
} finally {
    Database.rollback(sp);
}
