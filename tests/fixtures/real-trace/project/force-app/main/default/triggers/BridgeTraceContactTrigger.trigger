trigger BridgeTraceContactTrigger on Contact (before update) {
    for (Contact c : Trigger.new) {
        if (c.Bridge_Trace_Note__c != null && c.Bridge_Trace_Note__c != Trigger.oldMap.get(c.Id).Bridge_Trace_Note__c) {
            c.Description = 'Synced from account: ' + c.Bridge_Trace_Note__c;
        }
    }
}
