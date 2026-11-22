import { InboundWebhookEvent } from '../types.js';

export interface SalesforceRecord {
  id: string;
  type: 'Customer' | 'Contact';
  fields: Record<string, string>;
  lastModifiedAt: string;
  lastModifiedBy: string;
}

/**
 * Fake Salesforce CRM
 * Simulates Salesforce's official Record API (REST create/update)
 * and its webhook generation mechanism.
 */
export class FakeSalesforceCRM {
  private records: Map<string, SalesforceRecord> = new Map();
  private isOutage: boolean = false;
  private apiCallCount: number = 0;
  private webhookHistory: InboundWebhookEvent[] = [];

  constructor() {}

  public setOutage(outage: boolean): void {
    this.isOutage = outage;
  }

  public getIsOutage(): boolean {
    return this.isOutage;
  }

  public getApiCallCount(): number {
    return this.apiCallCount;
  }

  public resetApiCallCount(): void {
    this.apiCallCount = 0;
  }

  /**
   * Simulates PATCH /services/data/v59.0/sobjects/{type}/{id}
   */
  public async patchRecord(
    recordId: string,
    objectType: 'Customer' | 'Contact',
    fields: Record<string, string>,
    callerActor: string
  ): Promise<{ status: number; message: string }> {
    this.apiCallCount++;

    if (this.isOutage) {
      return { status: 503, message: 'Service Unavailable: Salesforce CRM is currently down.' };
    }

    let record = this.records.get(recordId);
    if (!record) {
      record = {
        id: recordId,
        type: objectType,
        fields: {},
        lastModifiedAt: new Date().toISOString(),
        lastModifiedBy: callerActor,
      };
      this.records.set(recordId, record);
    }

    // Apply updates
    for (const [key, val] of Object.entries(fields)) {
      record.fields[key] = val;
    }
    record.lastModifiedAt = new Date().toISOString();
    record.lastModifiedBy = callerActor;

    return { status: 204, message: 'No Content (Updated)' };
  }

  public getRecord(recordId: string): SalesforceRecord | undefined {
    return this.records.get(recordId);
  }

  public createWebhook(
    eventId: string,
    recordId: string,
    objectType: 'Customer' | 'Contact',
    occurredAt: string,
    changedBy: string,
    changedFields: Record<string, string>
  ): InboundWebhookEvent {
    const event: InboundWebhookEvent = {
      eventId,
      recordId,
      objectType,
      occurredAt,
      changedBy,
      changedFields,
    };
    this.webhookHistory.push(event);
    return event;
  }
}
