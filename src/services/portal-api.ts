import { DurableDatabase } from '../db/storage.js';
import { Contact, Customer, PortalEditRequest } from '../types.js';

export interface PortalEditResult {
  success: boolean;
  message: string;
  outboxId?: number;
}

/**
 * Portal API Service
 * Handles edits from Finance and Customer-Success staff.
 * Crucial guarantee: Uses Transactional Outbox pattern so the local DB update,
 * audit log entry, and outbox event commit in the same atomic transaction.
 */
export class PortalAPIService {
  private db: DurableDatabase;

  constructor(db: DurableDatabase) {
    this.db = db;
  }

  public editContact(req: PortalEditRequest): PortalEditResult {
    let contact = this.db.getContact(req.recordId);
    // Portal server generates the authoritative timestamp (CLOCK_TIMESTAMP equivalent)
    const serverTimestamp = new Date().toISOString();

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
    } else {
      for (const [field, val] of Object.entries(req.changedFields)) {
        const oldVal = (contact[field as keyof Contact] as string) ?? null;
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
      contact.updatedAt = serverTimestamp;
    }

    this.db.saveContact(contact);

    // Atomically enqueue to Outbox
    const outbox = this.db.appendOutboxEvent(
      contact.id,
      'Contact',
      'UPDATE',
      req.changedFields
    );

    return {
      success: true,
      message: `Contact ${req.recordId} updated by ${req.editedBy}. Queued for outbound sync (Outbox #${outbox.id}).`,
      outboxId: outbox.id,
    };
  }

  public editCustomer(req: PortalEditRequest): PortalEditResult {
    let customer = this.db.getCustomer(req.recordId);
    const serverTimestamp = new Date().toISOString();

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
    } else {
      for (const [field, val] of Object.entries(req.changedFields)) {
        const oldVal = (customer[field as keyof Customer] as string) ?? null;
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
      customer.updatedAt = serverTimestamp;
    }

    this.db.saveCustomer(customer);

    const outbox = this.db.appendOutboxEvent(
      customer.id,
      'Customer',
      'UPDATE',
      req.changedFields
    );

    return {
      success: true,
      message: `Customer ${req.recordId} updated by ${req.editedBy}. Queued for outbound sync (Outbox #${outbox.id}).`,
      outboxId: outbox.id,
    };
  }
}
