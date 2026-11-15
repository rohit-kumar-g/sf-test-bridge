// SF Test Bridge capture fixture: an @future method (its own log, later).
public class BridgeTraceFuture {
    @future
    public static void setNote(Id accountId) {
        Account a = [SELECT Id FROM Account WHERE Id = :accountId];
        a.Bridge_Trace_Note__c = 'Set by future';
        update a;
    }
}
