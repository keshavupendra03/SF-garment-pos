/**
 * Returns and exchanges.
 *
 * A return creates a credit note ("k":"CN", number CN-000001) in today's day file. The original bill
 * keeps how much of each line came back ("rq"), so a line can never be returned twice. Returned
 * pieces go back into stock unless marked damaged. The credit note is either paid out (cash, UPI,
 * card, or set off against the customer's credit dues) or kept open with a balance in N-open.json,
 * which Billing redeems with the "CN" payment mode (an exchange is simply that, right away).
 */
public with sharing class PosReturnController {
    private static final Integer SEARCH_DAYS = 120;
    private static final Integer SEARCH_CHUNK_DAYS = 15;
    private static final Integer MAX_RESULTS = 20;
    private static final Set<String> REFUND_MODES = new Set<String>{ 'CASH', 'UPI', 'CARD', 'DUE' };

    public class ReturnInput {
        public String billNo;
        public String billDate;
        public List<ReturnLine> lines;
        public String reason;
        public String outcome; // 'refund' | 'credit'
        public String refundMode; // CASH | UPI | CARD | DUE (outcome 'refund')
    }

    public class ReturnLine {
        public Integer idx;
        public Decimal q;
        public Boolean restock;
    }

    /**
     * Finds sales bills by bill number (scanned from the receipt or typed) or by customer mobile,
     * newest first, within the last SEARCH_DAYS days.
     */
    @AuraEnabled
    public static List<Map<String, Object>> findBills(String query) {
        String q = PosStorage.cleanCode(query);
        if (String.isBlank(q)) {
            throw fail('Scan the receipt or enter a bill number or mobile number.');
        }
        POS_Store__c store = PosStorage.findStore();
        List<Map<String, Object>> results = new List<Map<String, Object>>();
        if (store == null) {
            return results;
        }
        Boolean byMobile = Pattern.matches('[0-9]{10}', q);
        String marker = byMobile ? '"m":"' + q + '"' : '"no":' + JSON.serialize(q);
        String markerUpper = byMobile ? marker : '"no":' + JSON.serialize(q.toUpperCase());
        Date today = PosStorage.todayFor(store);

        for (Integer offset = 0; offset < SEARCH_DAYS && results.size() < MAX_RESULTS; offset += SEARCH_CHUNK_DAYS) {
            Set<String> names = new Set<String>();
            for (Integer d = offset; d < offset + SEARCH_CHUNK_DAYS; d++) {
                names.add(PosStorage.billFile(today.addDays(-d)));
            }
            Map<String, String> files = PosStorage.readMany(store.Id, names);
            List<String> keys = new List<String>(files.keySet());
            keys.sort();
            for (Integer k = keys.size() - 1; k >= 0 && results.size() < MAX_RESULTS; k--) {
                List<String> lines = files.get(keys[k]).split('\n');
                for (Integer i = lines.size() - 1; i >= 0 && results.size() < MAX_RESULTS; i--) {
                    String line = lines[i];
                    if (!(line.contains(marker) || line.contains(markerUpper)) || line.contains('"k":"CN"')) {
                        continue;
                    }
                    results.add((Map<String, Object>) JSON.deserializeUntyped(line));
                    if (!byMobile) {
                        return results; // bill numbers are unique
                    }
                }
            }
        }
        return results;
    }

    /** An open credit note, for redeeming in Billing. */
    @AuraEnabled
    public static Map<String, Object> getCreditNote(String noteNo) {
        String no = PosStorage.cleanCode(noteNo).toUpperCase();
        POS_Store__c store = PosStorage.findStore();
        Map<String, Object> notes = store == null
            ? new Map<String, Object>()
            : PosStorage.readJsonMap(store.Id, PosStorage.OPEN_NOTES_FILE);
        Map<String, Object> note = (Map<String, Object>) notes.get(no);
        if (note == null) {
            throw fail('No open credit note ' + no + '. It may be fully used already.');
        }
        note.put('no', no);
        return note;
    }

    @AuraEnabled
    public static Map<String, Object> processReturn(String returnJson) {
        ReturnInput input;
        try {
            input = (ReturnInput) JSON.deserialize(returnJson, ReturnInput.class);
        } catch (Exception e) {
            throw fail('Invalid return data.');
        }
        if (input == null || String.isBlank(input.billNo) || String.isBlank(input.billDate)) {
            throw fail('Pick the bill to return against.');
        }
        if (input.lines == null || input.lines.isEmpty()) {
            throw fail('Choose at least one item to return.');
        }
        if (input.outcome != 'refund' && input.outcome != 'credit') {
            throw fail('Choose refund or exchange.');
        }
        String refundMode = input.refundMode == null ? '' : input.refundMode.toUpperCase();
        if (input.outcome == 'refund' && !REFUND_MODES.contains(refundMode)) {
            throw fail('Choose how to refund.');
        }
        if (!Pattern.matches('[0-9]{4}-[0-9]{2}-[0-9]{2}', input.billDate)) {
            throw fail('Invalid bill date.');
        }

        Savepoint sp = Database.setSavepoint();
        try {
            POS_Store__c store = PosStorage.getStore(true);
            String tz = PosStorage.timeZoneOf(store);
            String billFile = PosStorage.billFileFor(input.billDate.replace('-', ''));
            List<String> dayLines = splitLines(PosStorage.readText(store.Id, billFile));
            String marker = '"no":' + JSON.serialize(input.billNo.trim());
            Integer lineIndex = -1;
            for (Integer i = 0; i < dayLines.size(); i++) {
                if (dayLines[i].contains(marker) && !dayLines[i].contains('"k":"CN"')) {
                    lineIndex = i;
                    break;
                }
            }
            if (lineIndex < 0) {
                throw fail('Bill ' + input.billNo + ' was not found.');
            }
            Map<String, Object> bill = (Map<String, Object>) JSON.deserializeUntyped(dayLines[lineIndex]);
            List<Object> billLines = (List<Object>) bill.get('l');

            List<Map<String, Object>> noteLines = new List<Map<String, Object>>();
            Map<Id, Decimal> restock = new Map<Id, Decimal>();
            Set<Integer> seen = new Set<Integer>();
            Decimal total = 0;
            Decimal tax = 0;
            for (ReturnLine rl : input.lines) {
                if (rl.idx == null || rl.idx < 0 || rl.idx >= billLines.size() || seen.contains(rl.idx)) {
                    throw fail('Invalid item selection.');
                }
                seen.add(rl.idx);
                if (rl.q == null || rl.q < 1 || rl.q != rl.q.round(System.RoundingMode.DOWN)) {
                    throw fail('Return quantities must be whole numbers.');
                }
                Map<String, Object> line = (Map<String, Object>) billLines[rl.idx];
                Decimal sold = dec(line.get('q'));
                Decimal already = dec(line.get('rq'));
                if (rl.q > sold - already) {
                    throw fail('Only ' + (sold - already).format() + ' of ' + line.get('n') + ' can still be returned.');
                }
                // Refund what was actually paid per piece (after item and bill discounts).
                Decimal amount = PosBillCalc.r2(dec(line.get('net')) * rl.q / sold);
                Decimal lineTax = PosBillCalc.r2(dec(line.get('tx')) * rl.q / sold);
                Boolean putBack = rl.restock != false;
                noteLines.add(new Map<String, Object>{
                    'id' => line.get('id'),
                    's' => line.get('s'),
                    'n' => line.get('n'),
                    'z' => line.get('z'),
                    'c' => line.get('c'),
                    'h' => line.get('h'),
                    'q' => rl.q,
                    'p' => PosBillCalc.r2(dec(line.get('net')) / sold),
                    'net' => amount,
                    'r' => line.get('r'),
                    'tx' => lineTax,
                    'rs' => putBack
                });
                line.put('rq', already + rl.q);
                total += amount;
                tax += lineTax;
                if (putBack && line.get('id') != null) {
                    Id productId = Id.valueOf(String.valueOf(line.get('id')));
                    restock.put(productId, (restock.containsKey(productId) ? restock.get(productId) : 0) + rl.q);
                }
            }
            Decimal grand = total.setScale(0, System.RoundingMode.HALF_UP);

            Map<String, Object> cu = (Map<String, Object>) bill.get('cu');
            String mobile = cu == null ? null : (String) cu.get('m');
            if (refundMode == 'DUE' && input.outcome == 'refund') {
                if (mobile == null) {
                    throw fail('This bill has no customer, so there are no dues to adjust.');
                }
                Map<String, Object> c = (Map<String, Object>) PosStorage.readCustomers(store.Id, mobile).get(mobile);
                if (c == null || dec(c.get('du')) < grand) {
                    throw fail('The customer owes less than ₹' + grand.format() + '. Choose another refund method.');
                }
            }

            Datetime now = Datetime.now();
            Decimal noteSeq = store.Next_Return_No__c == null ? 1 : store.Next_Return_No__c;
            String noteNo = 'CN-' + String.valueOf(noteSeq.longValue()).leftPad(6, '0');
            Boolean keepOpen = input.outcome == 'credit';
            Map<String, Object> note = new Map<String, Object>{
                'k' => 'CN',
                'no' => noteNo,
                'dt' => now.format('yyyy-MM-dd', tz),
                'tm' => now.format('HH:mm', tz),
                'ts' => now.getTime(),
                'by' => UserInfo.getName(),
                'ref' => bill.get('no'),
                'rdt' => bill.get('dt'),
                'rsn' => String.isBlank(input.reason) ? null : input.reason.trim().left(80),
                'cu' => cu,
                'l' => noteLines,
                'sub' => total,
                'dis' => 0,
                'tx' => tax,
                'ro' => grand - total,
                'g' => grand,
                'pay' => keepOpen ? new List<Object>() : new List<Object>{ new Map<String, Object>{ 'm' => refundMode, 'a' => grand } },
                'bal' => keepOpen ? grand : 0,
                'out' => input.outcome
            };

            // Original bill: remember returned quantities and the credit note.
            List<Object> notesOnBill = bill.containsKey('cn') ? (List<Object>) bill.get('cn') : new List<Object>();
            notesOnBill.add(noteNo);
            bill.put('cn', notesOnBill);
            dayLines[lineIndex] = JSON.serialize(bill);
            PosStorage.writeText(store.Id, billFile, String.join(dayLines, '\n'));

            if (!restock.isEmpty()) {
                List<POS_Product__c> products = [SELECT Id, Stock__c FROM POS_Product__c WHERE Id IN :restock.keySet() FOR UPDATE];
                for (POS_Product__c p : products) {
                    p.Stock__c = (p.Stock__c == null ? 0 : p.Stock__c) + restock.get(p.Id);
                }
                update products;
            }

            if (mobile != null) {
                Map<String, Object> customers = PosStorage.readCustomers(store.Id, mobile);
                Map<String, Object> c = (Map<String, Object>) customers.get(mobile);
                if (c != null) {
                    Decimal pointsPer100 = store.Points_Per_100__c == null ? 0 : store.Points_Per_100__c;
                    Decimal points = (grand / 100).round(System.RoundingMode.DOWN) * pointsPer100;
                    c.put('s', nonNegative(dec(c.get('s')) - grand));
                    c.put('pt', nonNegative(dec(c.get('pt')) - points));
                    if (refundMode == 'DUE' && input.outcome == 'refund') {
                        c.put('du', dec(c.get('du')) - grand);
                    }
                    PosStorage.writeText(store.Id, PosStorage.customerFile(mobile), JSON.serialize(customers));
                }
            }

            if (keepOpen && grand > 0) {
                Map<String, Object> open = PosStorage.readJsonMap(store.Id, PosStorage.OPEN_NOTES_FILE);
                open.put(noteNo, new Map<String, Object>{
                    'bal' => grand,
                    'amt' => grand,
                    'dt' => note.get('dt'),
                    'ref' => bill.get('no'),
                    'cu' => cu
                });
                PosStorage.writeText(store.Id, PosStorage.OPEN_NOTES_FILE, JSON.serialize(open));
            }

            store.Next_Return_No__c = noteSeq + 1;
            update store;
            PosStorage.appendLine(store.Id, PosStorage.billFileFor(now.format('yyyyMMdd', tz)), JSON.serialize(note));
            return note;
        } catch (AuraHandledException e) {
            Database.rollback(sp);
            throw e;
        } catch (Exception e) {
            Database.rollback(sp);
            throw fail('Could not save the return: ' + e.getMessage());
        }
    }

    private static List<String> splitLines(String text) {
        List<String> lines = new List<String>();
        if (String.isBlank(text)) {
            return lines;
        }
        for (String line : text.split('\n')) {
            if (String.isNotBlank(line)) {
                lines.add(line);
            }
        }
        return lines;
    }

    private static Decimal nonNegative(Decimal value) {
        return value < 0 ? 0 : value;
    }

    private static Decimal dec(Object value) {
        return PosStorage.toDecimal(value);
    }

    private static AuraHandledException fail(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message);
        return e;
    }
}
