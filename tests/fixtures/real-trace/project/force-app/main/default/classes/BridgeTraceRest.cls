// SF Test Bridge capture fixture: an Apex REST endpoint an integration calls.
@RestResource(urlMapping='/bridgetrace/*')
global with sharing class BridgeTraceRest {
    @HttpPost
    global static String setRating(String accountId, String rating) {
        Account a = [SELECT Id, Rating FROM Account WHERE Id = :accountId];
        a.Rating = rating;
        a.Bridge_Trace_Async__c = 'Set by Apex REST';
        update a;
        return 'ok';
    }
}
