import { DurableDatabase } from '../db/storage.js';
import { FakeSalesforceCRM } from './fake-salesforce.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { SF_INTEGRATION_USER } from '../types.js';

export interface SyncDrainStats {
  processedCount: number;
  successCount: number;
  failedCount: number;
  elapsedMs: number;
}

/**
 * Outbound Sync Worker
 * Polls the Transactional Outbox, enforces the Salesforce API rate limit via Token Bucket,
 * dispatches HTTP requests, handles failures/outages with backoff, and ensures zero data loss.
 */
export class OutboundSyncWorker {
  private db: DurableDatabase;
  private sfdc: FakeSalesforceCRM;
  private rateLimiter: TokenBucketRateLimiter;

  constructor(
    db: DurableDatabase,
    sfdc: FakeSalesforceCRM,
    rateLimiter: TokenBucketRateLimiter
  ) {
    this.db = db;
    this.sfdc = sfdc;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Drain available pending outbox records respecting the rate limit.
   */
  public async drainQueue(maxItems?: number): Promise<SyncDrainStats> {
    const startTime = Date.now();
    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;

    const pending = this.db.getPendingOutboxEvents();
    const batch = maxItems ? pending.slice(0, maxItems) : pending;

    for (const item of batch) {
      // 1. Acquire rate limit token before calling Salesforce
      await this.rateLimiter.acquire();

      processedCount++;

      try {
        // 2. Call Fake Salesforce CRM API using our dedicated integration user identity
        const res = await this.sfdc.patchRecord(
          item.recordId,
          item.objectType,
          item.payload,
          SF_INTEGRATION_USER
        );

        if (res.status === 204 || res.status === 200) {
          // Success
          this.db.updateOutboxStatus(item.id, 'SENT');
          successCount++;
        } else if (res.status === 503 || res.status === 429) {
          // Salesforce outage or rate limit backoff
          const backoffSeconds = Math.min(300, Math.pow(2, item.attempts + 1));
          const nextRetry = new Date(Date.now() + backoffSeconds * 1000).toISOString();
          this.db.updateOutboxStatus(item.id, 'FAILED', nextRetry);
          failedCount++;
        } else {
          this.db.updateOutboxStatus(item.id, 'FAILED');
          failedCount++;
        }
      } catch (err) {
        this.db.updateOutboxStatus(item.id, 'FAILED');
        failedCount++;
      }
    }

    return {
      processedCount,
      successCount,
      failedCount,
      elapsedMs: Date.now() - startTime,
    };
  }
}
