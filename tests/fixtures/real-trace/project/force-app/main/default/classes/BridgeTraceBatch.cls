// SF Test Bridge capture fixture: Batch Apex, also schedulable (System.schedule).
public class BridgeTraceBatch implements Database.Batchable<SObject>, Schedulable {
    public Database.QueryLocator start(Database.BatchableContext ctx) {
        return Database.getQueryLocator([SELECT Id FROM Account WHERE Name = 'Bridge Trace Acme']);
    }
    public void execute(Database.BatchableContext ctx, List<Account> scope) {
        for (Account a : scope) {
            a.Bridge_Trace_Async__c = 'Set by batch';
        }
        update scope;
    }
    public void finish(Database.BatchableContext ctx) {
        BridgeTraceFuture.setNote([SELECT Id FROM Account WHERE Name = 'Bridge Trace Acme' LIMIT 1].Id);
    }
    public void execute(SchedulableContext ctx) {
        Database.executeBatch(new BridgeTraceBatch());
    }
}
