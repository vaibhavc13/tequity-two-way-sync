import { DurableDatabase } from '../db/storage.js';
import { Contact, Customer, PortalEditRequest } from '../types.js';

export interface PortalEditResult {
  success: boolean;
  message: string;
  outboxId?: number;
  coalesced?: boolean;
  noOp?: boolean;
}

/**
 * Portal API Service
 * Handles edits from Finance and Customer-Success staff.
 * Uses Transactional Outbox pattern with dirty-field detection (no-op skip)
 * and pending outbox coalescing to protect Salesforce API quota.
 */
export class PortalAPIService {
  private db: DurableDatabase;

  constructor(db: DurableDatabase) {
    this.db = db;
  }

  public editContact(req: PortalEditRequest): PortalEditResult {
    let contact = this.db.getContact(req.recordId);
    const serverTimestamp = new Date().toISOString();
    let changedPayload: Record<string, string> = {};

    if (!contact) {
      contact = {
        id: req.recordId,
        salesforceId: req.recordId,
        customerId: req.changedFields['customerId'] || '',
        fullName: req.changedFields['fullName'] || 'Unknown Contact',
        phone: req.changedFields['phone'],
        email: req.changedFields['email'],
        city: req.changedFields['city'],
        owner: req.changedFields['owner'] || req.editedBy,
        fullNameUpdatedAt: serverTimestamp,
        phoneUpdatedAt: serverTimestamp,
        emailUpdatedAt: serverTimestamp,
        cityUpdatedAt: serverTimestamp,
        ownerUpdatedAt: serverTimestamp,
        customerIdUpdatedAt: serverTimestamp,
        createdAt: serverTimestamp,
        updatedAt: serverTimestamp,
      };
      changedPayload = { ...req.changedFields };
    } else {
      for (const [field, val] of Object.entries(req.changedFields)) {
        const oldVal = (contact[field as keyof Contact] as string) ?? null;
        if (oldVal === val) {
          continue; // Dirty check: skip unchanged fields
        }
        changedPayload[field] = val;
        (contact as any)[field] = val;
        (contact as any)[`${field}UpdatedAt`] = serverTimestamp;

        this.db.appendAuditLog({
          recordId: contact.id,
          objectType: 'Contact',
          fieldName: field,
          oldValue: oldVal,
          newValue: val,
          changedBy: req.editedBy,
          occurredAt: serverTimestamp,
          source: 'PORTAL_USER',
          status: 'APPLIED',
        });
      }

      if (Object.keys(changedPayload).length === 0) {
        return {
          success: true,
          message: `No fields changed on Contact ${req.recordId}. Outbox sync skipped (no-op).`,
          noOp: true,
        };
      }

      contact.updatedAt = serverTimestamp;
    }

    this.db.saveContact(contact);

    // Atomically enqueue or coalesce into existing PENDING outbox event
    const { event, coalesced } = this.db.upsertPendingOutboxEvent(
      contact.id,
      'Contact',
      'UPDATE',
      changedPayload
    );

    return {
      success: true,
      message: coalesced
        ? `Contact ${req.recordId} updated by ${req.editedBy}. Coalesced into pending Outbox #${event.id}.`
        : `Contact ${req.recordId} updated by ${req.editedBy}. Queued for outbound sync (Outbox #${event.id}).`,
      outboxId: event.id,
      coalesced,
    };
  }

  public editCustomer(req: PortalEditRequest): PortalEditResult {
    let customer = this.db.getCustomer(req.recordId);
    const serverTimestamp = new Date().toISOString();
    let changedPayload: Record<string, string> = {};

    if (!customer) {
      customer = {
        id: req.recordId,
        salesforceId: req.recordId,
        name: req.changedFields['name'] || 'Unknown Customer',
        status: (req.changedFields['status'] as any) || 'Prospect',
        owner: req.changedFields['owner'] || req.editedBy,
        nameUpdatedAt: serverTimestamp,
        statusUpdatedAt: serverTimestamp,
        ownerUpdatedAt: serverTimestamp,
        createdAt: serverTimestamp,
        updatedAt: serverTimestamp,
      };
      changedPayload = { ...req.changedFields };
    } else {
      for (const [field, val] of Object.entries(req.changedFields)) {
        const oldVal = (customer[field as keyof Customer] as string) ?? null;
        if (oldVal === val) {
          continue;
        }
        changedPayload[field] = val;
        (customer as any)[field] = val;
        (customer as any)[`${field}UpdatedAt`] = serverTimestamp;

        this.db.appendAuditLog({
          recordId: customer.id,
          objectType: 'Customer',
          fieldName: field,
          oldValue: oldVal,
          newValue: val,
          changedBy: req.editedBy,
          occurredAt: serverTimestamp,
          source: 'PORTAL_USER',
          status: 'APPLIED',
        });
      }

      if (Object.keys(changedPayload).length === 0) {
        return {
          success: true,
          message: `No fields changed on Customer ${req.recordId}. Outbox sync skipped (no-op).`,
          noOp: true,
        };
      }

      customer.updatedAt = serverTimestamp;
    }

    this.db.saveCustomer(customer);

    const { event, coalesced } = this.db.upsertPendingOutboxEvent(
      customer.id,
      'Customer',
      'UPDATE',
      changedPayload
    );

    return {
      success: true,
      message: coalesced
        ? `Customer ${req.recordId} updated by ${req.editedBy}. Coalesced into pending Outbox #${event.id}.`
        : `Customer ${req.recordId} updated by ${req.editedBy}. Queued for outbound sync (Outbox #${event.id}).`,
      outboxId: event.id,
      coalesced,
    };
  }
}
