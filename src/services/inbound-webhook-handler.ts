import { DurableDatabase } from '../db/storage.js';
import { InboundWebhookEvent, Contact, Customer, SF_INTEGRATION_USER } from '../types.js';

export interface WebhookProcessingResult {
  status: 'SUCCESS' | 'DUPLICATE_IGNORED' | 'LOOP_ECHO_SUPPRESSED' | 'OUT_OF_ORDER_DROPPED' | 'RECORD_NOT_FOUND';
  details: string;
  appliedFields: string[];
  supersededFields: string[];
}

/**
 * Inbound Webhook Processor
 * Implements:
 * 1. Duplicate detection (Idempotency)
 * 2. Sync loop suppression (Echo prevention)
 * 3. Field-level conflict resolution (Last-Write-Wins with granular timestamps)
 * 4. Audit trail preservation for all modifications and superseded edits
 */
export class InboundWebhookHandler {
  private db: DurableDatabase;

  constructor(db: DurableDatabase) {
    this.db = db;
  }

  public processWebhook(event: InboundWebhookEvent): WebhookProcessingResult {
    // 1. Check Idempotency (Duplicate Webhook)
    const isNew = this.db.recordInboundEvent(event);
    if (!isNew) {
      return {
        status: 'DUPLICATE_IGNORED',
        details: `Event ${event.eventId} already processed. Acknowledged without re-applying.`,
        appliedFields: [],
        supersededFields: [],
      };
    }

    // 2. Loop Suppression Check (Ping-Pong Prevention)
    if (event.changedBy === SF_INTEGRATION_USER) {
      // Record in audit log that an echo was acknowledged and suppressed
      this.db.appendAuditLog({
        recordId: event.recordId,
        objectType: event.objectType,
        fieldName: Object.keys(event.changedFields).join(','),
        oldValue: null,
        newValue: JSON.stringify(event.changedFields),
        changedBy: event.changedBy,
        occurredAt: event.occurredAt,
        source: 'SALESFORCE_WEBHOOK',
        status: 'ECHO_SUPPRESSED',
      });

      return {
        status: 'LOOP_ECHO_SUPPRESSED',
        details: `Webhook originated from portal sync user (${SF_INTEGRATION_USER}). Update accepted locally but outbound sync suppressed.`,
        appliedFields: [],
        supersededFields: [],
      };
    }

    // 3. Process Object Specific Updates
    if (event.objectType === 'Contact') {
      return this.processContactUpdate(event);
    } else {
      return this.processCustomerUpdate(event);
    }
  }

  private processContactUpdate(event: InboundWebhookEvent): WebhookProcessingResult {
    let contact = this.db.getContact(event.recordId);
    if (!contact) {
      // Auto-initialize if not existing (create webhook)
      contact = {
        id: event.recordId,
        salesforceId: event.recordId,
        customerId: event.changedFields['customerId'] || '',
        fullName: event.changedFields['fullName'] || 'Unknown',
        phone: event.changedFields['phone'],
        email: event.changedFields['email'],
        city: event.changedFields['city'],
        owner: event.changedFields['owner'] || 'Unassigned',
        fullNameUpdatedAt: event.occurredAt,
        phoneUpdatedAt: event.occurredAt,
        emailUpdatedAt: event.occurredAt,
        cityUpdatedAt: event.occurredAt,
        ownerUpdatedAt: event.occurredAt,
        customerIdUpdatedAt: event.occurredAt,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      };

      this.db.saveContact(contact);

      for (const [field, val] of Object.entries(event.changedFields)) {
        this.db.appendAuditLog({
          recordId: contact.id,
          objectType: 'Contact',
          fieldName: field,
          oldValue: null,
          newValue: val,
          changedBy: event.changedBy,
          occurredAt: event.occurredAt,
          source: 'SALESFORCE_WEBHOOK',
          status: 'APPLIED',
        });
      }

      return {
        status: 'SUCCESS',
        details: `Contact ${event.recordId} created via webhook.`,
        appliedFields: Object.keys(event.changedFields),
        supersededFields: [],
      };
    }

    const applied: string[] = [];
    const superseded: string[] = [];
    const incomingTime = new Date(event.occurredAt).getTime();

    // Field-level LWW Check
    for (const [field, newVal] of Object.entries(event.changedFields)) {
      const fieldTimestampProp = `${field}UpdatedAt` as keyof Contact;
      const currentTimestampStr = (contact[fieldTimestampProp] as string) || contact.updatedAt;
      const currentTimestamp = new Date(currentTimestampStr).getTime();

      const oldVal = (contact[field as keyof Contact] as string) ?? null;

      if (incomingTime >= currentTimestamp) {
        // Newer or equal: Apply update
        (contact as any)[field] = newVal;
        (contact as any)[fieldTimestampProp] = event.occurredAt;
        applied.push(field);

        this.db.appendAuditLog({
          recordId: contact.id,
          objectType: 'Contact',
          fieldName: field,
          oldValue: oldVal,
          newValue: newVal,
          changedBy: event.changedBy,
          occurredAt: event.occurredAt,
          source: 'SALESFORCE_WEBHOOK',
          status: 'APPLIED',
        });
      } else {
        // Out of order: Stale change, drop update but preserve in audit log
        superseded.push(field);

        this.db.appendAuditLog({
          recordId: contact.id,
          objectType: 'Contact',
          fieldName: field,
          oldValue: oldVal,
          newValue: newVal,
          changedBy: event.changedBy,
          occurredAt: event.occurredAt,
          source: 'SALESFORCE_WEBHOOK',
          status: 'SUPERSEDED_OUT_OF_ORDER',
        });
      }
    }

    contact.updatedAt = new Date().toISOString();
    this.db.saveContact(contact);

    return {
      status: superseded.length > 0 && applied.length === 0 ? 'OUT_OF_ORDER_DROPPED' : 'SUCCESS',
      details: `Processed Contact webhook. Applied: [${applied.join(', ')}]. Superseded: [${superseded.join(', ')}].`,
      appliedFields: applied,
      supersededFields: superseded,
    };
  }

  private processCustomerUpdate(event: InboundWebhookEvent): WebhookProcessingResult {
    let customer = this.db.getCustomer(event.recordId);
    if (!customer) {
      customer = {
        id: event.recordId,
        salesforceId: event.recordId,
        name: event.changedFields['name'] || 'Unknown Customer',
        status: (event.changedFields['status'] as any) || 'Prospect',
        owner: event.changedFields['owner'] || 'Unassigned',
        nameUpdatedAt: event.occurredAt,
        statusUpdatedAt: event.occurredAt,
        ownerUpdatedAt: event.occurredAt,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      };
      this.db.saveCustomer(customer);
      return {
        status: 'SUCCESS',
        details: `Customer ${event.recordId} created via webhook.`,
        appliedFields: Object.keys(event.changedFields),
        supersededFields: [],
      };
    }

    const applied: string[] = [];
    const superseded: string[] = [];
    const incomingTime = new Date(event.occurredAt).getTime();

    for (const [field, newVal] of Object.entries(event.changedFields)) {
      const fieldTimestampProp = `${field}UpdatedAt` as keyof Customer;
      const currentTimestampStr = (customer[fieldTimestampProp] as string) || customer.updatedAt;
      const currentTimestamp = new Date(currentTimestampStr).getTime();
      const oldVal = (customer[field as keyof Customer] as string) ?? null;

      if (incomingTime >= currentTimestamp) {
        (customer as any)[field] = newVal;
        (customer as any)[fieldTimestampProp] = event.occurredAt;
        applied.push(field);

        this.db.appendAuditLog({
          recordId: customer.id,
          objectType: 'Customer',
          fieldName: field,
          oldValue: oldVal,
          newValue: newVal,
          changedBy: event.changedBy,
          occurredAt: event.occurredAt,
          source: 'SALESFORCE_WEBHOOK',
          status: 'APPLIED',
        });
      } else {
        superseded.push(field);
        this.db.appendAuditLog({
          recordId: customer.id,
          objectType: 'Customer',
          fieldName: field,
          oldValue: oldVal,
          newValue: newVal,
          changedBy: event.changedBy,
          occurredAt: event.occurredAt,
          source: 'SALESFORCE_WEBHOOK',
          status: 'SUPERSEDED_OUT_OF_ORDER',
        });
      }
    }

    customer.updatedAt = new Date().toISOString();
    this.db.saveCustomer(customer);

    return {
      status: superseded.length > 0 && applied.length === 0 ? 'OUT_OF_ORDER_DROPPED' : 'SUCCESS',
      details: `Processed Customer webhook. Applied: [${applied.join(', ')}]. Superseded: [${superseded.join(', ')}].`,
      appliedFields: applied,
      supersededFields: superseded,
    };
  }
}
