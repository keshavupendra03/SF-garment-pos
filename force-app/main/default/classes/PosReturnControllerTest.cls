@IsTest
private class PosReturnControllerTest {
    private static final String MOBILE = '9876543210';

    @TestSetup
    static void setup() {
        insert new POS_Store__c(
            Name = 'Test Store',
            Bill_Prefix__c = 'T-',
            Next_Bill_No__c = 1,
            Next_Return_No__c = 1,
            Return_Days__c = 7,
            Tax_Threshold__c = 2500,
            Tax_Rate_Low__c = 5,
            Tax_Rate_High__c = 18,
            Points_Per_100__c = 1
        );
        insert new List<POS_Product__c>{
            new POS_Product__c(Name = 'Tee', SKU__c = 'TEE-M', Barcode__c = '111', Price__c = 1050, Stock__c = 10, Active__c = true),
            new POS_Product__c(Name = 'Jacket', SKU__c = 'JKT-L', Barcode__c = '222', Price__c = 5900, Stock__c = 2, Active__c = true)
        };
    }

    private static Id productId(String sku) {
        return [SELECT Id FROM POS_Product__c WHERE SKU__c = :sku].Id;
    }

    private static Decimal stock(String sku) {
        return [SELECT Stock__c FROM POS_Product__c WHERE SKU__c = :sku].Stock__c;
    }

    // 2 x Tee (2100, 5% GST) + 1 x Jacket at 10% off (5310, 18% GST) = 7410
    private static Map<String, Object> sale(String mode, Decimal amount) {
        return PosController.saveBill(JSON.serialize(new Map<String, Object>{
            'mobile' => MOBILE,
            'customerName' => 'Ravi',
            'billDiscount' => 0,
            'lines' => new List<Object>{
                new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 2, 'dp' => 0 },
                new Map<String, Object>{ 'id' => productId('JKT-L'), 'q' => 1, 'dp' => 10 }
            },
            'payments' => new List<Object>{ new Map<String, Object>{ 'm' => mode, 'a' => amount } }
        }));
    }

    private static Map<String, Object> returnItems(Map<String, Object> bill, Integer idx, Integer q, Boolean restock, String outcome, String mode) {
        return PosReturnController.processReturn(JSON.serialize(new Map<String, Object>{
            'billNo' => bill.get('no'),
            'billDate' => bill.get('dt'),
            'reason' => 'Size issue',
            'outcome' => outcome,
            'refundMode' => mode,
            'lines' => new List<Object>{ new Map<String, Object>{ 'idx' => idx, 'q' => q, 'restock' => restock } }
        }));
    }

    @IsTest
    static void refundsCashRestocksAndBlocksOverReturn() {
        Map<String, Object> bill = sale('CASH', 7410);

        Map<String, Object> note = returnItems(bill, 0, 1, true, 'refund', 'CASH');
        Assert.areEqual('CN-000001', note.get('no'));
        Assert.areEqual(1050, (Decimal) note.get('g'));
        Assert.areEqual(50, (Decimal) note.get('tx'), 'half of the 100 GST on two tees');
        Assert.areEqual(9, stock('TEE-M'), '10 - 2 sold + 1 returned');

        List<Map<String, Object>> found = PosReturnController.findBills((String) bill.get('no'));
        Assert.areEqual(1, found.size());
        Map<String, Object> line = (Map<String, Object>) ((List<Object>) found[0].get('l'))[0];
        Assert.areEqual(1, PosStorage.toDecimal(line.get('rq')));

        Map<String, Object> customer = PosController.findCustomer(MOBILE);
        Assert.areEqual(7410 - 1050, PosStorage.toDecimal(customer.get('s')));

        try {
            returnItems(bill, 0, 2, true, 'refund', 'CASH');
            Assert.fail('Expected over-return to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('can still be returned'), e.getMessage());
        }
    }

    @IsTest
    static void exchangeCreditNoteIsRedeemedInNextBill() {
        Map<String, Object> bill = sale('UPI', 7410);
        Map<String, Object> note = returnItems(bill, 1, 1, false, 'credit', null);
        Assert.areEqual(5310, (Decimal) note.get('bal'));
        Assert.areEqual(1, stock('JKT-L'), 'damaged jacket is not restocked');

        String noteNo = (String) note.get('no');
        Assert.areEqual(5310, PosStorage.toDecimal(PosReturnController.getCreditNote(noteNo).get('bal')));

        Map<String, Object> exchange = PosController.saveBill(JSON.serialize(new Map<String, Object>{
            'mobile' => MOBILE,
            'lines' => new List<Object>{ new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 1, 'dp' => 0 } },
            'payments' => new List<Object>{ new Map<String, Object>{ 'm' => 'CN', 'a' => 1050, 'ref' => noteNo } }
        }));
        Assert.areEqual(1050, (Decimal) exchange.get('g'));
        Assert.areEqual(4260, PosStorage.toDecimal(PosReturnController.getCreditNote(noteNo).get('bal')));

        try {
            PosController.saveBill(JSON.serialize(new Map<String, Object>{
                'lines' => new List<Object>{ new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 1, 'dp' => 0 } },
                'payments' => new List<Object>{ new Map<String, Object>{ 'm' => 'CN', 'a' => 5000, 'ref' => noteNo } }
            }));
            Assert.fail('Expected credit note above bill total to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('more than the bill'), e.getMessage());
        }
    }

    @IsTest
    static void refundAgainstDuesAndSearchByMobile() {
        Map<String, Object> bill = sale('CREDIT', 7410);
        returnItems(bill, 0, 2, true, 'refund', 'DUE');
        Assert.areEqual(7410 - 2100, PosStorage.toDecimal(PosController.findCustomer(MOBILE).get('du')));

        List<Map<String, Object>> byMobile = PosReturnController.findBills(MOBILE);
        Assert.areEqual(1, byMobile.size(), 'credit notes are not listed as bills');

        try {
            PosReturnController.getCreditNote('CN-999999');
            Assert.fail('Expected missing credit note error');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('No open credit note'), e.getMessage());
        }
    }

    @IsTest
    static void receiptShowsCreditNote() {
        Map<String, Object> bill = sale('CASH', 7410);
        Map<String, Object> note = returnItems(bill, 0, 1, true, 'refund', 'CASH');

        PageReference page = Page.PosReceipt;
        page.getParameters().put('d', ((String) note.get('dt')).replace('-', ''));
        page.getParameters().put('no', (String) note.get('no'));
        Test.setCurrentPage(page);
        PosReceiptController receipt = new PosReceiptController();
        Assert.isNull(receipt.errorMessage);
        Assert.isTrue(receipt.isCreditNote);
        Assert.areEqual(bill.get('no'), receipt.refBillNo);
    }
}
