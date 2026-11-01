/**
 * Server-side bill math. Prices are GST inclusive; the client mirrors this in posUtils.computeBill
 * for the live preview, but the values saved are always the ones computed here.
 *
 * GST slab is chosen per line from the per-piece taxable value (net of discounts, excluding GST):
 * up to Tax_Threshold__c -> Tax_Rate_Low__c, above -> Tax_Rate_High__c.
 */
public with sharing class PosBillCalc {
    public class CalcException extends Exception {}

    // CN = redeeming a credit note (its number travels in PaymentInput.ref).
    public static final Set<String> PAY_MODES = new Set<String>{ 'CASH', 'UPI', 'CARD', 'CREDIT', 'CN' };

    public static Map<String, Object> compute(
        POS_Store__c store,
        Map<Id, POS_Product__c> products,
        PosController.BillInput input,
        String mobile
    ) {
        Decimal low = nz(store.Tax_Rate_Low__c, 5);
        Decimal high = nz(store.Tax_Rate_High__c, 18);
        Decimal threshold = nz(store.Tax_Threshold__c, 2500);

        List<Map<String, Object>> lines = new List<Map<String, Object>>();
        List<Decimal> net0s = new List<Decimal>();
        Decimal gross = 0;
        Decimal lineDiscounts = 0;
        Decimal totalNet0 = 0;

        for (PosController.LineInput li : input.lines) {
            POS_Product__c p = products.get(li.id);
            if (p == null) {
                throw new CalcException('A product on this bill is no longer available.');
            }
            Decimal q = li.q;
            Decimal dp = nz(li.dp, 0);
            Decimal da = r2(nz(li.da, 0));
            if (dp < 0 || dp > 100) {
                throw new CalcException('Item discount must be between 0 and 100%.');
            }
            if (da < 0) {
                throw new CalcException('Item discount cannot be negative.');
            }
            if (dp > 0 && da > 0) {
                throw new CalcException('Use either a % or a ₹ discount on ' + p.Name + ', not both.');
            }
            // Small shops agree prices per customer, so the counter may override the catalog price.
            Decimal listPrice = nz(p.Price__c, 0);
            Decimal price = li.price == null ? listPrice : r2(li.price);
            if (price <= 0) {
                throw new CalcException('Price of ' + p.Name + ' must be more than zero.');
            }
            Decimal lineGross = r2(price * q);
            Decimal ld = da > 0 ? (da > lineGross ? lineGross : da) : r2(lineGross * dp / 100);
            Decimal n0 = lineGross - ld;
            gross += lineGross;
            lineDiscounts += ld;
            totalNet0 += n0;
            net0s.add(n0);
            lines.add(new Map<String, Object>{
                'id' => p.Id,
                's' => p.SKU__c,
                'n' => p.Name,
                'z' => p.Size__c,
                'c' => p.Color__c,
                'h' => p.HSN__c,
                'q' => q,
                'p' => price,
                'dp' => dp,
                'da' => da > 0 ? (da > lineGross ? lineGross : da) : 0,
                'ld' => ld
            });
            if (price != listPrice) {
                lines[lines.size() - 1].put('lp', listPrice); // catalog price, kept when the price was changed
            }
        }

        Decimal bd = r2(nz(input.billDiscount, 0));
        if (bd < 0) {
            throw new CalcException('Bill discount cannot be negative.');
        }
        if (bd > totalNet0) {
            bd = totalNet0;
        }

        // Spread the bill discount across lines by value; the last line absorbs rounding.
        Decimal allocated = 0;
        Decimal tax = 0;
        Decimal net = 0;
        for (Integer i = 0; i < lines.size(); i++) {
            Map<String, Object> line = lines[i];
            Decimal n0 = net0s[i];
            Decimal share = i == lines.size() - 1 ? bd - allocated : (totalNet0 == 0 ? 0 : r2(bd * n0 / totalNet0));
            allocated += share;
            Decimal lineNet = n0 - share;
            Decimal unit = lineNet.divide((Decimal) line.get('q'), 6);
            Decimal rate = unit.divide(1 + low / 100, 6) <= threshold ? low : high;
            Decimal lineTax = r2(lineNet - lineNet.divide(1 + rate / 100, 6));
            line.put('bs', share);
            line.put('net', lineNet);
            line.put('r', rate);
            line.put('tx', lineTax);
            tax += lineTax;
            net += lineNet;
        }

        Decimal grand = net.setScale(0, System.RoundingMode.HALF_UP);

        List<Map<String, Object>> pays = new List<Map<String, Object>>();
        Decimal paid = 0;
        Decimal credit = 0;
        Decimal noteTotal = 0;
        Boolean hasCash = false;
        if (input.payments != null) {
            for (PosController.PaymentInput pi : input.payments) {
                String mode = pi.m == null ? '' : pi.m.trim().toUpperCase();
                if (!PAY_MODES.contains(mode)) {
                    throw new CalcException('Unknown payment mode: ' + pi.m);
                }
                Decimal amount = r2(nz(pi.a, 0));
                if (amount <= 0) {
                    continue;
                }
                paid += amount;
                hasCash = hasCash || mode == 'CASH';
                if (mode == 'CREDIT') {
                    credit += amount;
                }
                Map<String, Object> pay = new Map<String, Object>{ 'm' => mode, 'a' => amount };
                if (mode == 'CN') {
                    if (String.isBlank(pi.ref)) {
                        throw new CalcException('Credit note number is missing.');
                    }
                    noteTotal += amount;
                    pay.put('ref', pi.ref.trim().toUpperCase());
                }
                pays.add(pay);
            }
        }
        if (noteTotal > grand) {
            throw new CalcException('Credit note amount is more than the bill total.');
        }
        if (paid < grand) {
            throw new CalcException('Payment is short by ₹' + (grand - paid).format() + '.');
        }
        Decimal change = paid - grand;
        if (change > 0 && !hasCash) {
            throw new CalcException('Only a cash payment can exceed the bill total.');
        }
        if (credit > 0 && mobile == null) {
            throw new CalcException('A credit sale needs the customer\'s mobile number.');
        }
        if (credit > 0 && change > 0) {
            throw new CalcException('Credit cannot be combined with returning change.');
        }

        return new Map<String, Object>{
            'l' => lines,
            'sub' => gross,
            'ld' => lineDiscounts,
            'bd' => bd,
            'dis' => lineDiscounts + bd,
            'tx' => tax,
            'ro' => grand - net,
            'g' => grand,
            'pay' => pays,
            'chg' => change,
            'due' => credit
        };
    }

    public static Decimal r2(Decimal value) {
        return value.setScale(2, System.RoundingMode.HALF_UP);
    }

    private static Decimal nz(Decimal value, Decimal fallback) {
        return value == null ? fallback : value;
    }
}
