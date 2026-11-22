import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import { DurableDatabase } from '../src/db/storage.js';
import { InboundWebhookHandler } from '../src/services/inbound-webhook-handler.js';

describe('Inbound Webhook - Rule 2: Out-of-Order Webhooks & Field-Level LWW', () => {
  const testDir = './.data_test_causality';
  let db: DurableDatabase;
  let handler: InboundWebhookHandler;
  const recordId = '0031A00000Abc';

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    db = new DurableDatabase(testDir);
    handler = new InboundWebhookHandler(db);

    // Seed contact with base state
    handler.processWebhook({
      eventId: 'evt_seed',
      recordId,
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:00:00.000Z',
      changedBy: 'init@client.example',
      changedFields: {
        fullName: 'Anita Roy',
        phone: '+919111111111',
        city: 'Delhi',
        owner: 'rep@client.example',
      },
    });
  });

  test('should drop stale out-of-order edits to current column but record them in audit log', () => {
    // 1. Newer event arrives first (11:30:10Z -> city = 'Mumbai')
    const newerRes = handler.processWebhook({
      eventId: 'evt_newer',
      recordId,
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:30:10.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: { city: 'Mumbai' },
    });
    assert.strictEqual(newerRes.status, 'SUCCESS');
    assert.strictEqual(db.getContact(recordId)?.city, 'Mumbai');

    // 2. Delayed older event arrives second (11:30:04Z -> city = 'Noida')
    const olderRes = handler.processWebhook({
      eventId: 'evt_older',
      recordId,
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:30:04.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: { city: 'Noida' },
    });
    assert.strictEqual(olderRes.status, 'OUT_OF_ORDER_DROPPED');
    assert.strictEqual(olderRes.supersededFields.includes('city'), true);

    // Current active value must remain Mumbai (newer value survived)
    const currentContact = db.getContact(recordId);
    assert.strictEqual(currentContact?.city, 'Mumbai');

    // Audit log must preserve the historical fact of the superseded Noida edit
    const auditLogs = db.getAuditLogs(recordId).filter((l) => l.fieldName === 'city');
    assert.strictEqual(auditLogs.length, 3); // init (Delhi) + newer (Mumbai) + stale (Noida)

    const staleEntry = auditLogs.find((l) => l.status === 'SUPERSEDED_OUT_OF_ORDER');
    assert.ok(staleEntry, 'Stale entry must exist in audit log');
    assert.strictEqual(staleEntry.newValue, 'Noida');
    assert.strictEqual(staleEntry.occurredAt, '2026-11-02T11:30:04.000Z');
  });

  test('should allow simultaneous edits to different fields of the same record to both survive', () => {
    // Edit 1: city updated to Bengaluru
    handler.processWebhook({
      eventId: 'evt_city',
      recordId,
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:31:00.000Z',
      changedBy: 'finance.user@client.example',
      changedFields: { city: 'Bengaluru' },
    });

    // Edit 2: phone updated to new phone number
    handler.processWebhook({
      eventId: 'evt_phone',
      recordId,
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:31:05.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: { phone: '+919876543210' },
    });

    const contact = db.getContact(recordId);
    assert.strictEqual(contact?.city, 'Bengaluru');
    assert.strictEqual(contact?.phone, '+919876543210');
  });
});
