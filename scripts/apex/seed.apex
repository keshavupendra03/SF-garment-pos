// Sample garment catalog for trying out the POS. Safe to re-run: upserts on SKU.
// Run: sf apex run --file scripts/apex/seed.apex --target-org posdev
List<POS_Product__c> products = new List<POS_Product__c>();
Integer barcode = 890100000;

// code => name, category, brand, sizes, colors, MRP, selling price, cost, HSN
Map<String, List<Object>> styles = new Map<String, List<Object>>{
    'TSH' => new List<Object>{ 'Round Neck T-Shirt', 'T-Shirts', 'UrbanWear', new List<String>{ 'S', 'M', 'L', 'XL' }, new List<String>{ 'Black', 'White', 'Navy' }, 599.00, 499.00, 220.00, '6109' },
    'JNS' => new List<Object>{ 'Slim Fit Jeans', 'Jeans', 'DenimCo', new List<String>{ '30', '32', '34', '36' }, new List<String>{ 'Blue', 'Black' }, 1999.00, 1699.00, 800.00, '6203' },
    'SHT' => new List<Object>{ 'Formal Shirt', 'Shirts', 'Elegance', new List<String>{ '38', '40', '42', '44' }, new List<String>{ 'White', 'Sky Blue' }, 1499.00, 1299.00, 600.00, '6205' },
    'KRT' => new List<Object>{ 'Cotton Kurta', 'Ethnic', 'Desi Roots', new List<String>{ 'M', 'L', 'XL' }, new List<String>{ 'Maroon', 'Mustard' }, 1299.00, 1099.00, 500.00, '6211' },
    'BLZ' => new List<Object>{ 'Wool Blend Blazer', 'Blazers', 'Elegance', new List<String>{ '38', '40', '42' }, new List<String>{ 'Charcoal' }, 6999.00, 5999.00, 3200.00, '6203' },
    'SAR' => new List<Object>{ 'Silk Saree', 'Sarees', 'Banaras Weaves', new List<String>{ 'Free' }, new List<String>{ 'Red', 'Green' }, 4499.00, 3999.00, 2100.00, '5007' }
};

for (String code : styles.keySet()) {
    List<Object> s = styles.get(code);
    for (String size : (List<String>) s[3]) {
        for (String color : (List<String>) s[4]) {
            barcode++;
            products.add(new POS_Product__c(
                Name = (String) s[0],
                SKU__c = code + '-' + color.replace(' ', '').left(3).toUpperCase() + '-' + size,
                Barcode__c = String.valueOf(barcode),
                Category__c = (String) s[1],
                Brand__c = (String) s[2],
                Size__c = size,
                Color__c = color,
                MRP__c = (Decimal) s[5],
                Price__c = (Decimal) s[6],
                Cost__c = (Decimal) s[7],
                HSN__c = (String) s[8],
                Stock__c = 10,
                Active__c = true
            ));
        }
    }
}
upsert products POS_Product__c.SKU__c;
System.debug(products.size() + ' products upserted');
