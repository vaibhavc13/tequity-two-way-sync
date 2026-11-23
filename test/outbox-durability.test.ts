import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import { DurableDatabase } from '../src/db/storage.js';
import { PortalAPIService } from '../src/services/portal-api.js';
import { OutboundSyncWorker } from '../src/services/outbound-sync-worker.js';
import { FakeSalesforceCRM } from '../src/services/fake-salesforce.js';
import { TokenBucketRateLimiter } from '../src/services/rate-limiter.js';

describe('Sync Engine - Rule 4: Outbox Durability, Outage Backoff & Restart Recovery', () => {
  const testDir = './.data_test_outbox';
  let db: DurableDatabase;
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
    portalApi = new PortalAPIService(db);
    syncWorker = new OutboundSyncWorker(db, sfdc, new TokenBucketRateLimiter(50));
  });

  test('should persist outbox events to disk during 6-hour CRM outage and recover them across process restart', async () => {
    // 1. Simulate Salesforce 6-hour outage
    sfdc.setOutage(true);

    // 2. Portal users save 10 consecutive edits during outage window
    for (let i = 1; i <= 10; i++) {
      portalApi.editContact({
        recordId,
        objectType: 'Contact',
        editedBy: `user${i}@client.example`,
        changedFields: { city: `City_${i}` },
      });
    }

    assert.strictEqual(db.getPendingOutboxEvents(true).length, 10);

    // 3. Worker tries to drain, fails with 503, applies exponential backoff
    const failedStats = await syncWorker.drainQueue(3);
    assert.strictEqual(failedStats.failedCount, 3);

    // 4. SIMULATE HARD PROCESS RESTART
    // Discard old in-memory references and instantiate fresh from disk storage
    const rebootedDb = new DurableDatabase(testDir);
    const recoveredItems = rebootedDb.getPendingOutboxEvents(true);

    assert.strictEqual(
      recoveredItems.length,
      10,
      'All 10 outbox events must survive process termination on disk'
    );

    // 5. Outage ends, Salesforce comes back online
    sfdc.setOutage(false);
    rebootedDb.resetAllBackoffs();

    const rebootedWorker = new OutboundSyncWorker(
      rebootedDb,
      sfdc,
      new TokenBucketRateLimiter(100)
    );

    // 6. Drain backlog
    const drainStats = await rebootedWorker.drainQueue();
    assert.strictEqual(drainStats.successCount, 10);
    assert.strictEqual(rebootedDb.getPendingOutboxEvents().length, 0);

    // Verify SFDC received the latest state
    const sfRecord = sfdc.getRecord(recordId);
    assert.strictEqual(sfRecord?.fields['city'], 'City_10');
  });
});
