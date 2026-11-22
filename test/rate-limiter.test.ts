import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TokenBucketRateLimiter } from '../src/services/rate-limiter.js';

describe('Token Bucket Rate Limiter', () => {
  test('should allow instantaneous bursts up to capacity', async () => {
    const rateLimiter = new TokenBucketRateLimiter(10, 5); // 10 tokens/s, capacity 5
    assert.strictEqual(rateLimiter.getAvailableTokens(), 5);

    for (let i = 0; i < 5; i++) {
      await rateLimiter.acquire();
    }
    assert.strictEqual(rateLimiter.getAvailableTokens(), 0);
  });

  test('should accurately pace requests when rate limit is exceeded', async () => {
    // 20 req/s means 1 token every 50ms
    const rateLimiter = new TokenBucketRateLimiter(20, 1);
    const start = Date.now();

    // Consume 3 tokens
    await rateLimiter.acquire();
    await rateLimiter.acquire();
    await rateLimiter.acquire();

    const elapsed = Date.now() - start;
    // For 2 additional tokens after initial burst at 20 tokens/sec: expect >= 90ms
    assert.ok(
      elapsed >= 80,
      `Rate limiter should pace requests over time (elapsed: ${elapsed}ms)`
    );
  });
});
