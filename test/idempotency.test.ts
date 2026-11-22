import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import { DurableDatabase } from '../src/db/storage.js';
import { InboundWebhookHandler } from '../src/services/inbound-webhook-handler.js';
import { InboundWebhookEvent } from '../src/types.js';

describe('Inbound Webhook - Rule 1: Duplicate Delivery (Idempotency)', () => {
  const testDir = './.data_test_idempotency';
  let db: DurableDatabase;
  let handler: InboundWebhookHandler;

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    db = new DurableDatabase(testDir);
    handler = new InboundWebhookHandler(db);
  });

  test('should process a fresh webhook exactly once and apply changes', () => {
    const event: InboundWebhookEvent = {
      eventId: 'evt_1001',
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:30:04.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: { phone: '+919876543210', city: 'Noida' },
    };

    const res = handler.processWebhook(event);
    assert.strictEqual(res.status, 'SUCCESS');
    assert.deepStrictEqual(res.appliedFields, ['phone', 'city']);

    const contact = db.getContact('0031A00000Abc');
    assert.ok(contact);
    assert.strictEqual(contact.phone, '+919876543210');
    assert.strictEqual(contact.city, 'Noida');

    // Verify audit log has 2 entries (one per field)
    const auditLogs = db.getAuditLogs('0031A00000Abc');
    assert.strictEqual(auditLogs.length, 2);
  });

  test('should detect and ignore duplicate webhook with identical eventId', () => {
    const event: InboundWebhookEvent = {
      eventId: 'evt_1001',
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:30:04.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: { phone: '+919876543210' },
    };

    // First arrival
    const res1 = handler.processWebhook(event);
    assert.strictEqual(res1.status, 'SUCCESS');

    // Duplicate network retry
    const res2 = handler.processWebhook(event);
    assert.strictEqual(res2.status, 'DUPLICATE_IGNORED');
    assert.match(res2.details, /already processed/i);
    assert.strictEqual(res2.appliedFields.length, 0);

    // Audit log should only contain 1 entry, duplicate must NOT append to audit log
    const auditLogs = db.getAuditLogs('0031A00000Abc');
    assert.strictEqual(auditLogs.length, 1);
  });
});
