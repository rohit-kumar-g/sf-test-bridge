// SF Test Bridge change-trace fixture: an LWC quick action that calls Apex.
import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import setRating from '@salesforce/apex/BridgeTraceController.setRating';

export default class BridgeTraceRating extends LightningElement {
    @api recordId;
    rating = 'Warm';

    get options() {
        return [
            { label: 'Hot', value: 'Hot' },
            { label: 'Warm', value: 'Warm' },
            { label: 'Cold', value: 'Cold' }
        ];
    }

    handleChange(event) {
        this.rating = event.detail.value;
    }

    async save() {
        try {
            await setRating({ accountId: this.recordId, rating: this.rating });
            this.dispatchEvent(new ShowToastEvent({ title: 'Rating saved', variant: 'success' }));
            notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
            this.dispatchEvent(new CloseActionScreenEvent());
        } catch (e) {
            const message = e && e.body && e.body.message ? e.body.message : String(e);
            this.dispatchEvent(new ShowToastEvent({ title: 'Rating not saved', message, variant: 'error' }));
        }
    }
}
