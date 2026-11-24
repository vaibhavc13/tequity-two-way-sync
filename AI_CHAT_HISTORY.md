# Engineering Prompt Log: Two-Way Sync Engine Architecture
## System: Salesforce CRM $\leftrightarrow$ PostgreSQL Operations Portal (5 Million Records)

> **Submission Note for Technical Reviewers:**  
> This log records the complete prompt progression, architectural guidance, pushbacks, and technical leadership applied while designing and implementing the two-way sync engine. It illustrates how the system was decomposed, how edge cases were identified, where AI assumptions were challenged and corrected, and how production-grade verification was directed.

---

### Prompt 1: Scope Definition, System Boundaries & Risk-Ranked Decomposition

**Candidate Prompt:**
```text
I am designing a two-way synchronization engine between our internal operations portal 
(PostgreSQL) and a client's Salesforce CRM.

Here are the operational parameters:
- Scale: 5,000,000 records across Customers (Accounts) and Contacts.
- Inbound: Salesforce sends HTTPS webhooks with sparse diffs (eventId, recordId, occurredAt, changedBy, changedFields).
- Outbound: Portal users (Finance & CS) edit records; we call Salesforce's REST API (create/update).
- Latency SLA: Bidirectional sync within <= 30 seconds when both systems are up.
- Rate Cap: Salesforce API allows maximum 100 requests/second.
- Resilience: Must tolerate a 6-hour Salesforce API outage without losing portal edits, then drain backlog.

DO NOT write any code yet. 

Before proposing components, I want an architectural risk decomposition. What are the 
critical failure modes in this distributed setup, and in what exact order should we 
tackle the subproblems so the highest risks are de-risked first?
```

**AI Response:**
> Excellent constraint framing. In a distributed two-way sync across public HTTPS between independent datastores, the core failure modes are:
> 
> 1. **Data Loss via Coarse Overwrites (Highest Risk):** Concurrent edits to different fields of the same record will overwrite each other if resolved at the row level.
> 2. **Network Ordering & Duplication (High Risk):** At-least-once webhook delivery causes duplicate events; public internet transit causes older edits to arrive after newer edits.
> 3. **The Sync Loop / Echo Problem (High Risk):** Updates dispatched to Salesforce trigger webhooks that bounce back to us, causing an infinite ping-pong loop.
> 4. **Extended Outage Durability (Medium Risk):** A 6-hour outage accumulates up to hundreds of thousands of edits. In-memory queues or naive worker buffers will drop data on process crash or restart.
> 
> **Recommended Subproblem Sequence:**
> - *Subproblem 1:* Storage schema & field-level concurrency model (prevents data corruption).
> - *Subproblem 2:* Inbound webhook idempotency & causality tracking (handles duplicates and reordering).
> - *Subproblem 3:* Outbound Transactional Outbox & Token Bucket Rate Limiter (handles durability & 100 req/s cap).
> - *Subproblem 4:* Loop suppression via actor identification (severs the echo cycle).
> - *Subproblem 5:* Outage backlog accumulation, crash recovery, and catch-up drain arithmetic.

---

### Prompt 2: Pushing Back on Concurrency & Demanding Immutable Audit Logging

**Candidate Prompt:**
```text
Let's drill into Subproblem 1.

Our client has a strict business requirement:
"A sales person creates a customer in Salesforce. The portal shows that customer. 
A finance person on the portal then corrects the billing city. Salesforce should show the new city. 
Later, a sales person changes the phone number in Salesforce. The portal should show the new phone, 
and the city the finance person set should still be there."
And: "The earlier values, who made them, and when, stay on record. Dropping that history counts as losing a change."

A standard row-level `updated_at` column in PostgreSQL with row-level Last-Write-Wins (LWW) 
will fail here: an incoming phone update will either overwrite the city or cause false merge conflicts.

How should we design the PostgreSQL schema so:
1. Edits to different fields of the same record both survive regardless of arrival order.
2. Edits to the same field have a mathematically justified winner.
3. Every historical edit, actor, and timestamp is immutably preserved?
```

**AI Response:**
> You have isolated the most common pitfall in dual-system CRM syncs. Row-level LWW is fundamentally unsuitable.
> 
> To solve this deterministically:
> 1. **Field-Level Granular Timestamps:**
>    Instead of only a row-level `updated_at`, every syncable column in `contacts` and `customers` maintains its own modification timestamp:
>    - `city` $\leftrightarrow$ `city_updated_at TIMESTAMPTZ`
>    - `phone` $\leftrightarrow$ `phone_updated_at TIMESTAMPTZ`
>    - `email` $\leftrightarrow$ `email_updated_at TIMESTAMPTZ`
>    - `full_name` $\leftrightarrow$ `full_name_updated_at TIMESTAMPTZ`
>    - `owner` $\leftrightarrow$ `owner_updated_at TIMESTAMPTZ`
> 
> 2. **Field-Level Last-Write-Wins (LWW):**
>    When an inbound webhook or portal save touches field $X$ with timestamp $t_{\text{event}}$:
>    - If $t_{\text{event}} \ge t_{\text{current}}$, apply the update and set `X_updated_at = t_event`.
>    - If $t_{\text{event}} < t_{\text{current}}$, drop the column update.
>    Because updates are isolated per column, updating `phone` does not modify `city` or `city_updated_at`. Both edits survive.
> 
> 3. **Immutable Audit History Table (`record_audit_log`):**
>    Every modification attempt (whether applied or rejected as stale) appends to an append-only log:
>    ```sql
>    CREATE TABLE record_audit_log (
>        id BIGSERIAL PRIMARY KEY,
>        record_id VARCHAR(36) NOT NULL,
>        object_type VARCHAR(50) NOT NULL,
>        field_name VARCHAR(50) NOT NULL,
>        old_value TEXT,
>        new_value TEXT,
>        changed_by VARCHAR(255) NOT NULL,
>        occurred_at TIMESTAMPTZ NOT NULL,
>        recorded_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
>        source VARCHAR(20) NOT NULL, -- 'SALESFORCE_WEBHOOK' | 'PORTAL_USER'
>        status VARCHAR(30) NOT NULL  -- 'APPLIED' | 'SUPERSEDED_OUT_OF_ORDER' | 'ECHO_SUPPRESSED'
>    );
>    ```
>    Even if an incoming edit is superseded because a newer value is already present, we insert it with `status = 'SUPERSEDED_OUT_OF_ORDER'`. This ensures complete non-destructive audit retention.

---

### Prompt 3: Rejecting In-Memory Queues & Requiring the Transactional Outbox Pattern

**Candidate Prompt:**
```text
Now let's examine the outbound path and the 6-hour Salesforce outage constraint.

If a finance user saves an edit on the portal, we could push that task into an in-memory 
worker queue or Redis. But consider what happens during a 6-hour outage:
- Salesforce is returning 503 Service Unavailable or timing out.
- Hundreds of edits accumulate.
- If our application process dies, restarts, or the host VM reboots, an in-memory queue 
  or non-WAL Redis cache will drop those pending calls.
- Furthermore, making synchronous Salesforce API calls inside the portal user's HTTP save request 
  causes browser timeouts and poor UX.

How do we architect the outbound pipeline so that pending calls survive application restarts, 
with zero data loss, while decoupling user latency from Salesforce availability?
```

**AI Response:**
> You are completely right—in-memory queues and synchronous external API calls violate the outage and crash constraints.
> 
> The standard distributed systems pattern here is the **Transactional Outbox Pattern** implemented directly within PostgreSQL.
> 
> **Mechanism:**
> 1. When a portal user saves an edit, the portal API server executes an atomic database transaction:
>    ```sql
>    BEGIN;
>    -- 1. Mutate business state
>    UPDATE contacts SET city = 'Noida', city_updated_at = CLOCK_TIMESTAMP() WHERE id = $1;
>    -- 2. Append audit log
>    INSERT INTO record_audit_log (...);
>    -- 3. Enqueue outbound job in the EXACT SAME transaction
>    INSERT INTO outbox_events (record_id, object_type, payload, status)
>    VALUES ($1, 'Contact', '{"city": "Noida"}', 'PENDING');
>    COMMIT;
>    ```
> 2. **Durability Guarantee:** Because the outbox record is written in the exact same ACID transaction as the business update, PostgreSQL Write-Ahead Logging (WAL) guarantees it is flushed to disk.
> 3. **Crash Recovery:** If Salesforce is dark for 6 hours and our service restarts 50 times, upon reboot the background sync worker queries:
>    `SELECT * FROM outbox_events WHERE status IN ('PENDING', 'FAILED') ORDER BY id ASC`
>    Zero writes are lost.
> 4. **Decoupled User Latency:** The user receives a `200 OK` in < 20ms because no external HTTP call is made during the user request.

---

### Prompt 4: Decoupling Loop Prevention (The Ping-Pong Problem)

**Candidate Prompt:**
```text
Let's address Rule 3: Sync Loop Prevention.

When our sync worker calls Salesforce PATCH to update a contact, Salesforce will update its DB 
and fire a webhook back to our webhook endpoint. If our webhook handler treats this as a new change, 
it will write to Postgres and enqueue an outbound outbox event, calling Salesforce again—looping forever.

What are our options to prevent this loop? I want a decoupled solution that does not require 
modifying the client's Salesforce schema if possible.
```

**AI Response:**
> Comparing the two primary approaches:
> 
> - **Option A: Custom Mutation Token (`Last_Sync_Mutation_Id__c`):**
>   Generate a UUID for each portal edit, send it to a custom Salesforce field, and have Salesforce echo it back in the webhook payload. Our webhook receiver checks a local cache and drops matching IDs.
>   *Downside:* Requires adding custom fields to the client's production CRM and maintaining an active sliding window cache.
> 
> - **Option B: Dedicated Integration Service Actor (Recommended):**
>   Our outbound sync worker authenticates against the Salesforce REST API using a dedicated service account: `tequity.sync.service@client.example`.
>   When Salesforce emits a webhook resulting from our API call, the payload's `changedBy` field is populated with this exact service identity.
> 
>   **Suppression Rule at the Webhook Boundary:**
>   ```ts
>   if (event.changedBy === 'tequity.sync.service@client.example') {
>     // Recognized as an echo of our own outbound write.
>     // 1. Update local metadata/audit log (marked as ECHO_SUPPRESSED)
>     // 2. DO NOT insert any record into outbox_events
>     return { status: 'LOOP_ECHO_SUPPRESSED' };
>   }
>   ```
>   *Advantage:* Zero schema changes to Salesforce, completely stateless, severs the loop immediately at the boundary.

---

### Prompt 5: Mathematical Correction: Calculating Net Velocity During Catch-Up

**Candidate Prompt:**
```text
Look at Section 10 of the design document regarding the 6-hour outage arithmetic.

Parameters:
- Salesforce rate cap: 100 requests/sec.
- Outage duration: 6 hours = 21,600 seconds.
- Let's assume a peak edit rate of 10 edits/sec.
- Total backlog accumulated = 21,600 * 10 = 216,000 edits.

Do NOT make the naive mistake of calculating catch-up time as:
Drain Time = 216,000 / 80 req/sec = 2,700 seconds (45 minutes).

Why is that wrong? Because when Salesforce recovers, portal users DO NOT stop working! 
Live edits continue arriving at 10 edits/sec while we are draining the backlog.

Recalculate the catch-up time using the true NET DRAIN VELOCITY, assuming our worker 
runs at a safe operating rate of 80 req/sec (leaving 20 req/s cushion under the 100 cap). 
Show the exact division for both peak and quiet workloads.
```

**AI Response:**
> Sharp catch. Omitting incoming live traffic during the catch-up phase creates a 15% underestimation of drain latency.
> 
> Here is the exact mathematical model:
> 
> #### System Parameters:
> - Outage duration ($T$): $21,600\text{ seconds}$ (6 hours).
> - Salesforce API limit: $100\text{ req/sec}$.
> - Worker operating rate ($R_{\text{worker}}$): $80\text{ req/sec}$ (leaving a $20\text{ req/sec}$ safety cushion for retry bursts).
> 
> #### Scenario 1: Peak Hours Outage
> - Peak edit rate ($E_{\text{peak}}$): $10\text{ edits/second}$.
> - Backlog accumulated on disk ($B_{\text{peak}}$):
>   $$B_{\text{peak}} = E_{\text{peak}} \times T = 10 \times 21,600 = \mathbf{216,000\text{ edits}}.$$
> - Once Salesforce recovers, live edits continue arriving at $10\text{ edits/sec}$.
> - Net drain velocity ($V_{\text{net}}$):
>   $$V_{\text{net}} = R_{\text{worker}} - E_{\text{peak}} = 80 - 10 = \mathbf{70\text{ edits/sec}}.$$
> - Exact drain time ($D_{\text{peak}}$):
>   $$D_{\text{peak}} = \frac{B_{\text{peak}}}{V_{\text{net}}} = \frac{216,000\text{ edits}}{70\text{ edits/sec}} = 3,085.71\text{ seconds}.$$
> - In Minutes (showing division):
>   $$\frac{3,085.71}{60} = \mathbf{51.43\text{ minutes}} \quad (\approx 51\text{m } 26\text{s}).$$
> 
> #### Scenario 2: Quiet Hours Outage (Night / Weekend)
> - Quiet edit rate ($E_{\text{quiet}}$): $0.5\text{ edits/second}$.
> - Backlog accumulated ($B_{\text{quiet}}$):
>   $$B_{\text{quiet}} = 0.5 \times 21,600 = \mathbf{10,800\text{ edits}}.$$
> - Net drain velocity:
>   $$V_{\text{net}} = 80 - 0.5 = 79.5\text{ edits/sec}.$$
> - Drain time:
>   $$\frac{10,800}{79.5} = 135.85\text{ seconds} = \mathbf{2.26\text{ minutes}}.$$

---

### Prompt 6: Directing Implementation & Mandating Node.js Native Unit Tests

**Candidate Prompt:**
```text
Now let's build the working TypeScript implementation for Node.js 20+.

Requirements:
1. Zero bloat: Do not install external test frameworks or database engines. 
   Use Node's native test runner (`node:test` and `node:assert`) and simulate Postgres 
   with an atomic disk-backed JSON store that persists across process restarts.
2. Build a FakeSalesforceCRM service with a configurable outage toggle (HTTP 503) 
   and webhook generator.
3. Build a TokenBucketRateLimiter that enforces the 100 req/s cap.
4. Structure modules cleanly under `src/`:
   - types.ts
   - db/storage.ts
   - services/rate-limiter.ts
   - services/fake-salesforce.ts
   - services/inbound-webhook-handler.ts
   - services/portal-api.ts
   - services/outbound-sync-worker.ts
   - demo.ts
5. Create dedicated unit test files in `test/` for each specific rule:
   - idempotency.test.ts
   - causality.test.ts
   - loop-prevention.test.ts
   - outbox-durability.test.ts
   - rate-limiter.test.ts

Let's generate the code and run the tests.
```

**AI Response:**
> Created the complete project structure and test suites. Compiled with `tsc` and ran:
> ```bash
> npm test
> ```
> All 8 tests across 5 test suites passed using Node's native test runner.

---

### Prompt 7: Catching Real-World Systems Edge Cases During Verification

**Candidate Prompt:**
```text
I observed two issues during verification that we must fix:

1. Outbox Backoff Filtering on Restart:
   In the 6-hour outage test, 5 items failed with HTTP 503 and received backoff retry 
   timestamps (`nextRetryAt = now + backoff`). When simulating process restart, 
   `getPendingOutboxEvents()` filtered by `nextRetryAt <= now`, returning only 10 items instead of 15.
   Update `getPendingOutboxEvents` so it can report all uncompleted items on disk, and add 
   `resetAllBackoffs()` to simulate time advancement when Salesforce recovers.

2. Windows OS File Locking (EPERM):
   On Windows, rapid disk flushes using `fs.renameSync(tempPath, filePath)` throw 
   `EPERM: operation not permitted` due to OS file handle locking latency.
   Update `flushToDisk()` in `storage.ts` to write directly with synchronous error handling.

Fix these and re-verify.
```

**AI Response:**
> Both fixes applied:
> - `src/db/storage.ts`: Added `getPendingOutboxEvents(includeBackoff: boolean)` and `resetAllBackoffs()`.
> - Switched `flushToDisk()` to direct synchronous file writing, eliminating Windows `EPERM` collisions.
> - Verified with `npm test` and `npm start`: both pass with zero errors.

---

### Prompt 8: Adding Live HTTP Server for Manual Interview Testing

**Candidate Prompt:**
```text
The automated demo (`npm start`) and unit tests (`npm test`) are great, but during the review call, 
the interviewers might say: "Can we test this with curl or send a custom payload live?"

Let's add a lightweight HTTP server (`src/server.ts`) using Node's built-in `http` module:
- GET  /api/contact/:id -> Returns contact state and full audit history
- POST /api/webhooks/salesforce -> Receives incoming webhooks
- POST /api/portal/edit -> Simulates portal user save
- POST /api/sync/drain -> Triggers worker drain
- POST /api/salesforce/outage -> Toggles 6-hour outage on/off
- GET  /api/status -> Returns outbox queue count and CRM status

Add script `"server": "tsc && node dist/src/server.js"` in package.json.
```

**AI Response:**
> Implemented `src/server.ts` and added `npm run server` to `package.json`.
> Tested manually via HTTP:
> - Webhook idempotency test returned `DUPLICATE_IGNORED`.
> - Out-of-order webhook test returned `OUT_OF_ORDER_DROPPED` and recorded `SUPERSEDED_OUT_OF_ORDER` in audit log.
> - Echo webhook returned `LOOP_ECHO_SUPPRESSED`.
> - Portal edit during outage queued to outbox (`pendingOutboxCount: 1`), survived, and drained to `0` upon recovery.
