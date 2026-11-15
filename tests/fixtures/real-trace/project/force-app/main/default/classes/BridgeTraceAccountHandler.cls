// SF Test Bridge change-trace fixture: a trigger handler with the usual patterns
// (field set in before update, addError, related records updated in after update,
// async work queued).
public with sharing class BridgeTraceAccountHandler {
    public static void beforeUpdate(List<Account> news, Map<Id, Account> olds) {
        for (Account a : news) {
            Account old = olds.get(a.Id);
            if (a.Name != null && a.Name.contains('BLOCK')) {
                a.addError('Name must not contain BLOCK (BridgeTraceAccountHandler)');
                continue;
            }
            if (a.AnnualRevenue != old.AnnualRevenue) {
                a.Bridge_Trace_Score__c = score(a.AnnualRevenue);
            }
            if (a.Industry != old.Industry) {
                a.Bridge_Trace_Note__c = 'Industry changed to ' + a.Industry;
            }
        }
    }

    public static Decimal score(Decimal revenue) {
        if (revenue == null) {
            return 0;
        }
        Decimal s = revenue / 100000;
        return s.round();
    }

    public static void afterUpdate(List<Account> news, Map<Id, Account> olds) {
        Set<Id> tierChanged = new Set<Id>();
        Set<Id> revenueChanged = new Set<Id>();
        for (Account a : news) {
            if (a.Bridge_Trace_Tier__c != olds.get(a.Id).Bridge_Trace_Tier__c) {
                tierChanged.add(a.Id);
            }
            if (a.AnnualRevenue != olds.get(a.Id).AnnualRevenue) {
                revenueChanged.add(a.Id);
            }
        }
        if (!tierChanged.isEmpty()) {
            Map<Id, Account> byId = new Map<Id, Account>(news);
            List<Contact> cons = [SELECT Id, AccountId FROM Contact WHERE AccountId IN :tierChanged];
            for (Contact c : cons) {
                c.Bridge_Trace_Note__c = 'Tier ' + byId.get(c.AccountId).Bridge_Trace_Tier__c;
            }
            update cons;
        }
        if (!revenueChanged.isEmpty() && !System.isQueueable() && !System.isFuture()) {
            System.enqueueJob(new BridgeTraceQueueable(revenueChanged));
        }
    }
}
