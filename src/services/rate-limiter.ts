/**
 * High-accuracy Token Bucket Rate Limiter
 * Enforces a strict requests-per-second cap (e.g. 100 req/sec for Salesforce API).
 */
export class TokenBucketRateLimiter {
  private capacity: number;
  private tokens: number;
  private refillRate: number; // tokens per second
  private lastRefillTimestamp: number;

  constructor(maxRequestsPerSecond: number, capacity?: number) {
    this.refillRate = maxRequestsPerSecond;
    this.capacity = capacity ?? maxRequestsPerSecond;
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedTimeInSeconds = (now - this.lastRefillTimestamp) / 1000;
    const tokensToAdd = elapsedTimeInSeconds * this.refillRate;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefillTimestamp = now;
    }
  }

  /**
   * Acquire a token. If bucket is empty, asynchronously waits until a token is refilled.
   */
  public async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate required wait time for 1 token to refill
    const tokensNeeded = 1 - this.tokens;
    const waitTimeMs = Math.ceil((tokensNeeded / this.refillRate) * 1000);

    await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
    return this.acquire();
  }

  public getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}
