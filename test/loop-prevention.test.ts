import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import { DurableDatabase } from '../src/db/storage.js';
import { InboundWebhookHandler } from '../src/services/inbound-webhook-handler.js';
import { PortalAPIService } from '../src/services/portal-api.js';
import { OutboundSyncWorker } from '../src/services/outbound-sync-worker.js';
import { FakeSalesforceCRM } from '../src/services/fake-salesforce.js';
import { TokenBucketRateLimiter } from '../src/services/rate-limiter.js';
import { SF_INTEGRATION_USER } from '../src/types.js';

describe('Sync Engine - Rule 3: Loop Prevention (Ping-Pong Elimination)', () => {
  const testDir = './.data_test_loop';
  let db: DurableDatabase;
  let handler: InboundWebhookHandler;
  let portalApi: PortalAPIService;
  let syncWorker: OutboundSyncWorker;
  let sfdc: FakeSalesforceCRM;
  const recordId = '0031A00000Abc';

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    db = new DurableDatabase(testDir);
    sfdc = new FakeSalesforceCRM();
    handler = new InboundWebhookHandler(db);
    portalApi = new PortalAPIService(db);
    syncWorker = new OutboundSyncWorker(db, sfdc, new TokenBucketRateLimiter(100));

    // Seed contact
    db.saveContact({
      id: recordId,
      salesforceId: recordId,
      customerId: '0011A00000Xyz',
      fullName: 'Anita Roy',
      phone: '+919111111111',
      city: 'Delhi',
      owner: 'rep@client.example',
      fullNameUpdatedAt: new Date().toISOString(),
      phoneUpdatedAt: new Date().toISOString(),
      emailUpdatedAt: new Date().toISOString(),
      cityUpdatedAt: new Date().toISOString(),
      ownerUpdatedAt: new Date().toISOString(),
      customerIdUpdatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  test('should suppress outbox queueing when receiving an echo webhook from portal sync actor', async () => {
    // 1. Finance user edits city in Portal
    const editRes = portalApi.editContact({
      recordId,
      objectType: 'Contact',
      editedBy: 'finance.user@client.example',
      changedFields: { city: 'Bengaluru' },
    });
    assert.strictEqual(editRes.success, true);
    assert.strictEqual(db.getPendingOutboxEvents().length, 1);

    // 2. Outbound worker syncs the edit to Salesforce
    const drainRes = await syncWorker.drainQueue();
    assert.strictEqual(drainRes.successCount, 1);
    assert.strictEqual(db.getPendingOutboxEvents().length, 0);

    // Verify SFDC received change attributed to the portal integration user
    const sfdcRecord = sfdc.getRecord(recordId);
    assert.strictEqual(sfdcRecord?.fields['city'], 'Bengaluru');
    assert.strictEqual(sfdcRecord?.lastModifiedBy, SF_INTEGRATION_USER);

    // 3. Salesforce emits an echo webhook
    const echoWebhook = sfdc.createWebhook(
      'evt_echo_1',
      recordId,
      'Contact',
      new Date().toISOString(),
      SF_INTEGRATION_USER,
      { city: 'Bengaluru' }
    );

    // 4. Inbound handler receives the echo
    const inboundRes = handler.processWebhook(echoWebhook);
    assert.strictEqual(inboundRes.status, 'LOOP_ECHO_SUPPRESSED');

    // 5. CRITICAL CHECK: Pending outbox must remain 0! Loop is severed.
    const pendingOutbox = db.getPendingOutboxEvents();
    assert.strictEqual(pendingOutbox.length, 0, 'No outbound task must be created from echo webhook');

    // Audit log should register the echo suppression
    const auditEcho = db.getAuditLogs(recordId).find((l) => l.status === 'ECHO_SUPPRESSED');
    assert.ok(auditEcho, 'Echo suppression must be tracked in audit log');
  });
});
