@IsTest
private class PosControllerTest {
    private static final String MOBILE = '9876543210';

    @TestSetup
    static void setup() {
        insert new POS_Store__c(
            Name = 'Test Store',
            Bill_Prefix__c = 'T-',
            Next_Bill_No__c = 1,
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

    private static String billJson(String mobile, List<Object> lines, List<Object> payments) {
        return JSON.serialize(new Map<String, Object>{
            'mobile' => mobile,
            'customerName' => 'Ravi',
            'billDiscount' => 0,
            'lines' => lines,
            'payments' => payments
        });
    }

    private static List<Object> standardLines() {
        return new List<Object>{
            new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 2, 'dp' => 0 },
            new Map<String, Object>{ 'id' => productId('JKT-L'), 'q' => 1, 'dp' => 10 }
        };
    }

    private static List<Object> pay(String mode, Decimal amount) {
        return new List<Object>{ new Map<String, Object>{ 'm' => mode, 'a' => amount } };
    }

    @IsTest
    static void savesBillWithSlabTaxStockAndCustomer() {
        Test.startTest();
        Map<String, Object> bill = PosController.saveBill(billJson(MOBILE, standardLines(), pay('CASH', 8000)));
        Test.stopTest();

        // Tee: 2 x 1050 = 2100, per piece 1000 ex-GST -> 5% -> tax 100.
        // Jacket: 5900 - 10% = 5310, 4500 ex-GST -> 18% -> tax 810.
        Assert.areEqual('T-000001', bill.get('no'));
        Assert.areEqual(7410, (Decimal) bill.get('g'));
        Assert.areEqual(910, (Decimal) bill.get('tx'));
        Assert.areEqual(590, (Decimal) bill.get('chg'));

        Assert.areEqual(8, [SELECT Stock__c FROM POS_Product__c WHERE SKU__c = 'TEE-M'].Stock__c);
        Assert.areEqual(1, [SELECT Stock__c FROM POS_Product__c WHERE SKU__c = 'JKT-L'].Stock__c);
        Assert.areEqual(2, [SELECT Next_Bill_No__c FROM POS_Store__c].Next_Bill_No__c);

        Map<String, Object> customer = PosController.findCustomer(MOBILE);
        Assert.areEqual('Ravi', customer.get('n'));
        Assert.areEqual(1, PosStorage.toDecimal(customer.get('v')));
        Assert.areEqual(7410, PosStorage.toDecimal(customer.get('s')));
        Assert.areEqual(74, PosStorage.toDecimal(customer.get('pt')));

        String today = Datetime.now().format('yyyy-MM-dd', 'Asia/Kolkata');
        Assert.isTrue(PosController.getBills(today, today).contains('"no":"T-000001"'));
        Assert.areEqual(1, PosController.getCustomers().size());
    }

    @IsTest
    static void secondBillAppendsToSameDayFile() {
        PosController.saveBill(billJson(null, standardLines(), pay('UPI', 7410)));
        PosController.saveBill(billJson(null, standardLines(), pay('CARD', 7410)));

        String today = Datetime.now().format('yyyy-MM-dd', 'Asia/Kolkata');
        List<String> lines = PosController.getBills(today, today).split('\n');
        Assert.areEqual(2, lines.size());
        Assert.areEqual(1, [SELECT COUNT() FROM Attachment WHERE Name LIKE 'B-%']);
    }

    @IsTest
    static void billDiscountIsSpreadAcrossLines() {
        Map<String, Object> input = new Map<String, Object>{
            'billDiscount' => 410,
            'lines' => standardLines(),
            'payments' => pay('CASH', 7000)
        };
        Map<String, Object> bill = PosController.saveBill(JSON.serialize(input));
        Assert.areEqual(7000, (Decimal) bill.get('g'));
        Assert.areEqual(0, (Decimal) bill.get('chg'));
    }

    @IsTest
    static void counterPriceAndRupeeDiscount() {
        // 2 tees sold at an agreed ₹900 each (list ₹1050) with ₹100 off the line.
        Map<String, Object> bill = PosController.saveBill(JSON.serialize(new Map<String, Object>{
            'lines' => new List<Object>{
                new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 2, 'price' => 900, 'da' => 100 }
            },
            'payments' => pay('CASH', 1700)
        }));
        Map<String, Object> line = (Map<String, Object>) ((List<Object>) bill.get('l'))[0];
        Assert.areEqual(900, (Decimal) line.get('p'));
        Assert.areEqual(1050, (Decimal) line.get('lp'), 'list price kept when the price was changed');
        Assert.areEqual(100, (Decimal) line.get('ld'));
        Assert.areEqual(1700, (Decimal) bill.get('g'));
        Assert.areEqual(80.95, (Decimal) bill.get('tx'));

        try {
            PosController.saveBill(JSON.serialize(new Map<String, Object>{
                'lines' => new List<Object>{
                    new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 1, 'dp' => 10, 'da' => 50 }
                },
                'payments' => pay('CASH', 2000)
            }));
            Assert.fail('Expected % and ₹ discount together to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('not both'), e.getMessage());
        }
        try {
            PosController.saveBill(JSON.serialize(new Map<String, Object>{
                'lines' => new List<Object>{ new Map<String, Object>{ 'id' => productId('TEE-M'), 'q' => 1, 'price' => 0 } },
                'payments' => pay('CASH', 2000)
            }));
            Assert.fail('Expected zero price to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('more than zero'), e.getMessage());
        }
    }

    @IsTest
    static void rejectsShortPayment() {
        try {
            PosController.saveBill(billJson(null, standardLines(), pay('UPI', 100)));
            Assert.fail('Expected a short payment error');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('short'), e.getMessage());
        }
        Assert.areEqual(10, [SELECT Stock__c FROM POS_Product__c WHERE SKU__c = 'TEE-M'].Stock__c);
    }

    @IsTest
    static void creditNeedsCustomerAndTracksDue() {
        try {
            PosController.saveBill(billJson(null, standardLines(), pay('CREDIT', 7410)));
            Assert.fail('Expected credit without customer to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('mobile'), e.getMessage());
        }

        PosController.saveBill(billJson(MOBILE, standardLines(), pay('CREDIT', 7410)));
        Assert.areEqual(7410, PosStorage.toDecimal(PosController.findCustomer(MOBILE).get('du')));
    }

    @IsTest
    static void rejectsInvalidInput() {
        try {
            PosController.saveBill(billJson('123', standardLines(), pay('CASH', 8000)));
            Assert.fail('Expected bad mobile to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('10 digits'), e.getMessage());
        }
        try {
            PosController.saveBill(billJson(null, new List<Object>(), pay('CASH', 8000)));
            Assert.fail('Expected empty bill to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('at least one item'), e.getMessage());
        }
        try {
            PosController.getBills('2026-01-01', '2026-12-31');
            Assert.fail('Expected long range to fail');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('days'), e.getMessage());
        }
    }

    @IsTest
    static void receiptBootstrapAndStorage() {
        Map<String, Object> bill = PosController.saveBill(billJson(MOBILE, standardLines(), pay('CASH', 8000)));

        PageReference page = Page.PosReceipt;
        page.getParameters().put('d', ((String) bill.get('dt')).replace('-', ''));
        page.getParameters().put('no', (String) bill.get('no'));
        Test.setCurrentPage(page);
        PosReceiptController receipt = new PosReceiptController();
        Assert.isNull(receipt.errorMessage);
        Assert.areEqual(2, receipt.lines.size());
        Assert.areEqual(2, receipt.taxRows.size());
        Assert.areEqual(7410, receipt.grandTotal);

        Assert.areEqual('Test Store', PosController.getStoreInfo().Name);

        Map<String, Object> boot = PosController.getBootstrap();
        Assert.areEqual(2, ((List<POS_Product__c>) boot.get('products')).size());

        Map<String, Object> storage = PosController.getStorageInfo();
        Assert.areEqual(2, (Integer) storage.get('files'));
        Assert.isTrue((Long) storage.get('billBytes') > 0);
    }
}
