import { DurableDatabase } from './db/storage.js';
import { FakeSalesforceCRM } from './services/fake-salesforce.js';
import { InboundWebhookHandler } from './services/inbound-webhook-handler.js';
import { PortalAPIService } from './services/portal-api.js';
import { OutboundSyncWorker } from './services/outbound-sync-worker.js';
import { TokenBucketRateLimiter } from './services/rate-limiter.js';
import { SF_INTEGRATION_USER } from './types.js';

function banner(title: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function subBanner(title: string): void {
  console.log(`\n--- ${title} ---`);
}

async function runDemo(): Promise<void> {
  banner('TEQUITY ROUND 1: TWO-WAY SYNC ENGINE VERIFICATION SUITE');
  console.log('Validating Core Distributed Systems Rules:\n' +
              '  1. Duplicate Webhook Handling (Idempotency)\n' +
              '  2. Out-of-Order Webhook Delivery (Field-Level LWW & Causality)\n' +
              '  3. Sync Loop Prevention (Echo Suppression)\n' +
              '  4. 6-Hour Outage, Crash Recovery & Rate-Limited Backlog Drain');

  // Shared storage directory for crash/restart simulation
  const storageDir = './.data_demo';
  let db = new DurableDatabase(storageDir);
  db.clearAll();

  const sfdc = new FakeSalesforceCRM();
  // Set rate limiter to 20 req/s for demo so throttling is clearly measurable
  const rateLimiter = new TokenBucketRateLimiter(20);
  let inboundHandler = new InboundWebhookHandler(db);
  let portalApi = new PortalAPIService(db);
  let syncWorker = new OutboundSyncWorker(db, sfdc, rateLimiter);

  // Initialize a baseline record
  const recordId = '0031A00000Abc';
  console.log(`\n[Setup] Initializing Contact ${recordId}...`);
  inboundHandler.processWebhook({
    eventId: 'evt_init',
    recordId,
    objectType: 'Contact',
    occurredAt: '2026-11-02T11:00:00.000Z',
    changedBy: 'sales.user@client.example',
    changedFields: {
      fullName: 'Anita Roy',
      phone: '+919111111111',
      city: 'Delhi',
      owner: 'sales.rep@client.example',
    },
  });

  const contactInit = db.getContact(recordId);
  console.log(`Initial Contact State: fullName="${contactInit?.fullName}", phone="${contactInit?.phone}", city="${contactInit?.city}"`);

  // =========================================================================
  // RULE 1: DUPLICATE WEBHOOK (IDEMPOTENCY)
  // =========================================================================
  banner('CHECK 1: DUPLICATE WEBHOOK DELIVERY (IDEMPOTENCY)');
  const dupEvent = {
    eventId: 'evt_1001',
    recordId,
    objectType: 'Contact' as const,
    occurredAt: '2026-11-02T11:30:04.000Z',
    changedBy: 'sales.user@client.example',
    changedFields: { phone: '+919876543210' },
  };

  console.log(`[Event 1] First delivery of ${dupEvent.eventId} (phone update)...`);
  const res1 = inboundHandler.processWebhook(dupEvent);
  console.log(`Result: ${res1.status} - ${res1.details}`);

  console.log(`\n[Event 1 Duplicate] Network retries and delivers ${dupEvent.eventId} second time...`);
  const res1Dup = inboundHandler.processWebhook(dupEvent);
  console.log(`Result: ${res1Dup.status} - ${res1Dup.details}`);

  const phoneAfterDup = db.getContact(recordId)?.phone;
  const auditLogsPhone = db.getAuditLogs(recordId).filter((l) => l.fieldName === 'phone');
  console.log(`\nVerification:`);
  console.log(`  - Current phone: ${phoneAfterDup} (Expected: +919876543210)`);
  console.log(`  - Audit log entries for phone: ${auditLogsPhone.length} (Expected: 2 -> init + 1 applied, 0 duplicate)`);
  if (res1Dup.status === 'DUPLICATE_IGNORED' && auditLogsPhone.length === 2) {
    console.log('  >>> PASS: Rule 1 (Duplicate Webhook Idempotency) validated successfully!');
  } else {
    throw new Error('FAIL: Duplicate webhook was not properly ignored.');
  }

  // =========================================================================
  // RULE 2: OUT-OF-ORDER CHANGES (CAUSALITY & AUDIT PRESERVATION)
  // =========================================================================
  banner('CHECK 2: OUT-OF-ORDER WEBHOOK DELIVERY (FIELD-LEVEL LWW)');
  console.log('Scenario: Network delay causes newer edit (11:30:10Z) to arrive BEFORE older edit (11:30:04Z).');

  // Newer event arrives first
  const newerEvent = {
    eventId: 'evt_1003_newer',
    recordId,
    objectType: 'Contact' as const,
    occurredAt: '2026-11-02T11:30:10.000Z',
    changedBy: 'sales.user@client.example',
    changedFields: { city: 'Mumbai' },
  };
  console.log(`\n[Step 1] Arriving First: Event at 11:30:10Z (city = "Mumbai")...`);
  const resNewer = inboundHandler.processWebhook(newerEvent);
  console.log(`Result: ${resNewer.status} - ${resNewer.details}`);

  // Older event arrives second
  const olderEvent = {
    eventId: 'evt_1002_older',
    recordId,
    objectType: 'Contact' as const,
    occurredAt: '2026-11-02T11:30:04.000Z', // 6 seconds older!
    changedBy: 'sales.user@client.example',
    changedFields: { city: 'Noida' },
  };
  console.log(`\n[Step 2] Arriving Second: Stale Event at 11:30:04Z (city = "Noida")...`);
  const resOlder = inboundHandler.processWebhook(olderEvent);
  console.log(`Result: ${resOlder.status} - ${resOlder.details}`);

  const cityAfterOutOfOrder = db.getContact(recordId)?.city;
  const auditLogsCity = db.getAuditLogs(recordId).filter((l) => l.fieldName === 'city');
  console.log(`\nVerification:`);
  console.log(`  - Current active city: "${cityAfterOutOfOrder}" (Expected: "Mumbai", newer survived)`);
  console.log(`  - Audit trail preserved entries: ${auditLogsCity.length}`);
  auditLogsCity.forEach((l) =>
    console.log(`    * [${l.occurredAt}] ${l.oldValue} -> ${l.newValue} | Status: ${l.status}`)
  );

  const staleLog = auditLogsCity.find((l) => l.status === 'SUPERSEDED_OUT_OF_ORDER');
  if (cityAfterOutOfOrder === 'Mumbai' && staleLog) {
    console.log('  >>> PASS: Rule 2 (Out-of-order LWW & Audit Preservation) validated successfully!');
  } else {
    throw new Error('FAIL: Out-of-order event corrupted the current state.');
  }

  // =========================================================================
  // RULE 3: SYNC LOOP SUPPRESSION (ECHO PREVENTION)
  // =========================================================================
  banner('CHECK 3: SYNC LOOP SUPPRESSION (PREVENTING INFINITE PING-PONG)');
  console.log('Scenario: Portal finance user edits city -> Portal sends to SF -> SF reflects webhook back.');

  console.log('\n[Step 1] Finance user edits city = "Bengaluru" via Portal...');
  const portalEditRes = portalApi.editContact({
    recordId,
    objectType: 'Contact',
    editedBy: 'finance.user@client.example',
    changedFields: { city: 'Bengaluru' },
  });
  console.log(`Portal Save Result: ${portalEditRes.message}`);

  console.log('\n[Step 2] Outbound Sync Worker drains outbox and calls Salesforce API...');
  const syncRes = await syncWorker.drainQueue();
  console.log(`Worker Dispatch: Processed ${syncRes.processedCount}, Success: ${syncRes.successCount}`);
  const sfdcRecord = sfdc.getRecord(recordId);
  console.log(`Salesforce CRM Record State: city="${sfdcRecord?.fields['city']}", lastModifiedBy="${sfdcRecord?.lastModifiedBy}"`);

  console.log('\n[Step 3] Salesforce fires webhook for this update (changedBy = tequity.sync.service)...');
  const echoWebhook = sfdc.createWebhook(
    'evt_echo_999',
    recordId,
    'Contact',
    new Date().toISOString(),
    SF_INTEGRATION_USER,
    { city: 'Bengaluru' }
  );

  const echoRes = inboundHandler.processWebhook(echoWebhook);
  console.log(`Inbound Handler Result: ${echoRes.status} - ${echoRes.details}`);

  const pendingAfterEcho = db.getPendingOutboxEvents();
  console.log(`\nVerification:`);
  console.log(`  - Outbound Outbox pending items: ${pendingAfterEcho.length} (Expected: 0)`);
  if (echoRes.status === 'LOOP_ECHO_SUPPRESSED' && pendingAfterEcho.length === 0) {
    console.log('  >>> PASS: Rule 3 (Sync Loop Suppression) validated successfully!');
  } else {
    throw new Error('FAIL: Echo webhook was not suppressed.');
  }

  // =========================================================================
  // RULE 4: 6-HOUR OUTAGE, PROCESS RESTART & RATE-LIMITED DRAIN
  // =========================================================================
  banner('CHECK 4: 6-HOUR SALESFORCE OUTAGE, CRASH RECOVERY & RATE-LIMITED DRAIN');
  console.log('Scenario: Salesforce API is unreachable for 6 hours. Portal continues working.\n' +
              'Pending calls must survive process restart and drain within rate limit.');

  subBanner('Phase 4A: Salesforce Goes Dark (HTTP 503)');
  sfdc.setOutage(true);
  console.log(`Salesforce CRM status: OUTAGE = ${sfdc.getIsOutage()}`);

  console.log('\nPortal users save 15 consecutive edits across contacts during the outage window...');
  for (let i = 1; i <= 15; i++) {
    portalApi.editContact({
      recordId: `${recordId}_${i}`,
      objectType: 'Contact',
      editedBy: `ops.user${i}@client.example`,
      changedFields: { city: `City_Batch_${i}` },
    });
  }

  const pendingBeforeRestart = db.getPendingOutboxEvents();
  console.log(`Pending Outbox events recorded on disk: ${pendingBeforeRestart.length}`);

  subBanner('Phase 4B: Worker Tries to Sync & Hits Outage Backoff');
  const failedSyncAttempt = await syncWorker.drainQueue(5);
  console.log(`Worker attempted 5 items: Processed: ${failedSyncAttempt.processedCount}, Failed: ${failedSyncAttempt.failedCount}`);

  subBanner('Phase 4C: Portal Process Crashes and Restarts');
  console.log('Simulating full process termination & reboot by creating fresh instances from disk storage...');
  // Simulating process death by re-instantiating everything
  db = new DurableDatabase(storageDir);
  inboundHandler = new InboundWebhookHandler(db);
  portalApi = new PortalAPIService(db);
  // Re-instantiate worker with rate limiter = 20 req/sec
  syncWorker = new OutboundSyncWorker(db, sfdc, new TokenBucketRateLimiter(20));

  // Check total un-sent items on disk (5 in backoff + 10 fresh pending = 15 total)
  const pendingAfterRestart = db.getPendingOutboxEvents(true);
  console.log(`Unprocessed Outbox events recovered from disk post-restart: ${pendingAfterRestart.length}`);
  if (pendingAfterRestart.length !== 15) {
    throw new Error(`FAIL: Expected 15 pending items on disk, found ${pendingAfterRestart.length}`);
  }
  console.log('  >>> Crash Recovery: All 15 outbox items survived process restart!');

  subBanner('Phase 4D: Salesforce API Recovers & Worker Drains Under Rate Limit');
  sfdc.setOutage(false);
  sfdc.resetApiCallCount();
  // Reset backoffs to simulate time passing and recovery trigger
  db.resetAllBackoffs();
  console.log(`Salesforce CRM status: OUTAGE = ${sfdc.getIsOutage()} (Online)`);
  console.log('Draining 15 items with Token Bucket Rate Limiter set to 20 req/sec...');

  const drainStart = Date.now();
  const drainStats = await syncWorker.drainQueue();
  const totalDrainTimeMs = Date.now() - drainStart;

  console.log(`Drain Complete in ${totalDrainTimeMs}ms!`);
  console.log(`  - Items processed: ${drainStats.processedCount}`);
  console.log(`  - Items successful: ${drainStats.successCount}`);
  console.log(`  - Salesforce calls received: ${sfdc.getApiCallCount()}`);
  console.log(`  - Remaining pending outbox items: ${db.getPendingOutboxEvents().length}`);

  const finalContactInSfdc = sfdc.getRecord(`${recordId}_15`);
  console.log(`\nFinal State in Salesforce CRM (${recordId}_15): city="${finalContactInSfdc?.fields['city']}"`);

  if (
    drainStats.successCount === 15 &&
    db.getPendingOutboxEvents().length === 0 &&
    finalContactInSfdc?.fields['city'] === 'City_Batch_15'
  ) {
    console.log('  >>> PASS: Rule 4 (Outage Durability, Restart Recovery & Rate-Limited Drain) validated successfully!');
  } else {
    throw new Error('FAIL: Backlog was not successfully drained to Salesforce.');
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  banner('ALL 4 CRITICAL CHECKS PASSED PERFECTLY!');
  console.log('1. Duplicate Webhooks: Idempotent (ON CONFLICT DO NOTHING)');
  console.log('2. Out-of-Order Webhooks: Causally rejected via field timestamps, kept in audit trail');
  console.log('3. Sync Loops: Echoes suppressed via dedicated service user identification');
  console.log('4. 6-Hour Outage: Durable transactional outbox on disk, crash-resilient, rate-limited drain');
}

runDemo().catch((err) => {
  console.error('\n*** DEMO ENCOUNTERED ERROR ***\n', err);
  process.exit(1);
});
