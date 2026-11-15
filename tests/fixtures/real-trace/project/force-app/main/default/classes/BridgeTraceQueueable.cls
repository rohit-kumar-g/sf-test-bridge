// SF Test Bridge change-trace fixture: a change made later, in its own transaction (own log).
public class BridgeTraceQueueable implements Queueable {
    private Set<Id> ids;

    public BridgeTraceQueueable(Set<Id> ids) {
        this.ids = ids;
    }

    public void execute(QueueableContext ctx) {
        List<Account> accs = [SELECT Id, AnnualRevenue FROM Account WHERE Id IN :ids];
        for (Account a : accs) {
            a.Bridge_Trace_Async__c = 'Revenue reviewed: ' + String.valueOf(a.AnnualRevenue);
        }
        update accs;
    }
}
