trigger BridgeTraceAccountTrigger on Account (before update, after update) {
    if (Trigger.isBefore) {
        BridgeTraceAccountHandler.beforeUpdate(Trigger.new, Trigger.oldMap);
    } else {
        BridgeTraceAccountHandler.afterUpdate(Trigger.new, Trigger.oldMap);
    }
}
