// SF Test Bridge change-trace fixture: Apex called from a flow.
public with sharing class BridgeTraceInvocable {
    @InvocableMethod(label='Bridge Trace: Compute Label')
    public static List<String> computeLabel(List<Id> accountIds) {
        Map<Id, Account> accs = new Map<Id, Account>([SELECT Id, Name, Rating FROM Account WHERE Id IN :accountIds]);
        List<String> out = new List<String>();
        for (Id i : accountIds) {
            Account a = accs.get(i);
            out.add(a.Name + ' / ' + (a.Rating == null ? 'unrated' : a.Rating));
        }
        return out;
    }
}
