// SF Test Bridge change-trace fixture: Apex called by an LWC (bridgeTraceRating).
public with sharing class BridgeTraceController {
    @AuraEnabled
    public static void setRating(Id accountId, String rating) {
        Account a = [SELECT Id, Rating FROM Account WHERE Id = :accountId];
        a.Rating = rating;
        a.Bridge_Trace_Note__c = 'Rating set from LWC';
        update a;
    }
}
