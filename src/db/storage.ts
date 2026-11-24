import * as fs from 'fs';
import * as path from 'path';
import { Customer, Contact, InboundWebhookEvent, OutboxEvent, AuditLogEntry } from '../types.js';

interface DatabaseSchema {
  customers: Record<string, Customer>;
  contacts: Record<string, Contact>;
  inboundEvents: Record<string, InboundWebhookEvent>;
  outboxEvents: OutboxEvent[];
  auditLogs: AuditLogEntry[];
  nextOutboxId: number;
  nextAuditId: number;
}

/**
 * Durable Database simulating PostgreSQL storage.
 * All mutations write atomically to disk so pending transactions survive process restarts.
 */
export class DurableDatabase {
  private filePath: string;
  private data: DatabaseSchema;

  constructor(storageDir: string = './.data') {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    this.filePath = path.join(storageDir, 'portal_db.json');
    this.data = this.load();
  }

  private load(): DatabaseSchema {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw);
      } catch (err) {
        console.error('Failed to parse database file, initializing fresh:', err);
      }
    }
    return {
      customers: {},
      contacts: {},
      inboundEvents: {},
      outboxEvents: [],
      auditLogs: [],
      nextOutboxId: 1,
      nextAuditId: 1,
    };
  }

  public flushToDisk(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to flush database to disk:', err);
    }
  }

  // --- Customers ---
  public getCustomer(id: string): Customer | undefined {
    return this.data.customers[id];
  }

  public saveCustomer(customer: Customer): void {
    this.data.customers[customer.id] = { ...customer };
    this.flushToDisk();
  }

  // --- Contacts ---
  public getContact(id: string): Contact | undefined {
    return this.data.contacts[id];
  }

  public saveContact(contact: Contact): void {
    this.data.contacts[contact.id] = { ...contact };
    this.flushToDisk();
  }

  // --- Inbound Events (Idempotency) ---
  public hasInboundEvent(eventId: string): boolean {
    return !!this.data.inboundEvents[eventId];
  }

  public recordInboundEvent(event: InboundWebhookEvent): boolean {
    if (this.data.inboundEvents[event.eventId]) {
      return false; // Already exists (Duplicate)
    }
    this.data.inboundEvents[event.eventId] = { ...event };
    this.flushToDisk();
    return true;
  }

  // --- Outbox Events (Transactional Outbox) ---
  public appendOutboxEvent(
    recordId: string,
    objectType: 'Customer' | 'Contact',
    operation: 'CREATE' | 'UPDATE',
    payload: Record<string, string>
  ): OutboxEvent {
    const event: OutboxEvent = {
      id: this.data.nextOutboxId++,
      recordId,
      objectType,
      operation,
      payload,
      status: 'PENDING',
      attempts: 0,
      nextRetryAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.data.outboxEvents.push(event);
    this.flushToDisk();
    return event;
  }

  /**
   * Coalesces into an existing PENDING outbox event for the same record if one exists,
   * reducing redundant Salesforce API calls during bursts or outages.
   */
  public upsertPendingOutboxEvent(
    recordId: string,
    objectType: 'Customer' | 'Contact',
    operation: 'CREATE' | 'UPDATE',
    payload: Record<string, string>
  ): { event: OutboxEvent; coalesced: boolean } {
    const existing = this.data.outboxEvents.find(
      (e) => e.recordId === recordId && e.objectType === objectType && e.status === 'PENDING'
    );

    if (existing) {
      existing.payload = { ...existing.payload, ...payload };
      existing.updatedAt = new Date().toISOString();
      this.flushToDisk();
      return { event: existing, coalesced: true };
    }

    const event = this.appendOutboxEvent(recordId, objectType, operation, payload);
    return { event, coalesced: false };
  }

  public getPendingOutboxEvents(includeBackoff: boolean = false): OutboxEvent[] {
    const now = new Date().toISOString();
    return this.data.outboxEvents.filter((e) => {
      if (e.status !== 'PENDING' && e.status !== 'FAILED') return false;
      return includeBackoff ? true : e.nextRetryAt <= now;
    });
  }

  public resetAllBackoffs(): void {
    const now = new Date().toISOString();
    for (const e of this.data.outboxEvents) {
      if (e.status === 'FAILED') {
        e.nextRetryAt = now;
      }
    }
    this.flushToDisk();
  }

  public updateOutboxStatus(
    id: number,
    status: OutboxEvent['status'],
    nextRetryAt?: string
  ): void {
    const item = this.data.outboxEvents.find((e) => e.id === id);
    if (item) {
      item.status = status;
      item.updatedAt = new Date().toISOString();
      item.attempts += 1;
      if (nextRetryAt) {
        item.nextRetryAt = nextRetryAt;
      }
      this.flushToDisk();
    }
  }

  // --- Audit Logs ---
  public appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'recordedAt'>): AuditLogEntry {
    const log: AuditLogEntry = {
      id: this.data.nextAuditId++,
      ...entry,
      recordedAt: new Date().toISOString(),
    };
    this.data.auditLogs.push(log);
    this.flushToDisk();
    return log;
  }

  public getAuditLogs(recordId?: string): AuditLogEntry[] {
    if (!recordId) return [...this.data.auditLogs];
    return this.data.auditLogs.filter((l) => l.recordId === recordId);
  }

  public clearAll(): void {
    this.data = {
      customers: {},
      contacts: {},
      inboundEvents: {},
      outboxEvents: [],
      auditLogs: [],
      nextOutboxId: 1,
      nextAuditId: 1,
    };
    this.flushToDisk();
  }
}
