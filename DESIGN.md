# Two-Way Sync Engine: Customers & Contacts (Salesforce & Tequity Portal)
## Architecture Design Document

**Author:** Candidate (Round 1 Engineering Submission)  
**Target Systems:** Salesforce CRM & Tequity Operations Portal (PostgreSQL)  
**Scale:** 5,000,000 active records (Customers & Contacts combined)  
**SLA:** Bi-directional sync visibility $\le$ 30 seconds under normal operation  

---

## 1. Assumptions & Open Questions

Before locking the architecture, the following engineering assumptions are made to resolve ambiguities in the problem brief. For each assumption, we note the explicit trade-off and what would change if the answer went the other way.

### 1.1 Assumptions & Reversal Impact

1. **Peak & Quiet Edit Rate:**
   * *Assumption:* Peak edit volume across both systems is **10 edits/second** (portal + salesforce combined); quiet hour volume is **0.5 edits/second** (e.g., night/weekends), with an average daytime volume of **2 edits/second**. Across 5 million records, 10 edits/sec represents ~864,000 field modifications per day, standard for an enterprise sales/ops team of 200–500 active concurrent operators.
   * *Reversal Impact:* If peak edit rate is 150 edits/second (exceeding Salesforce's 100 req/sec API cap), an asynchronous batching/bulk API architecture (e.g., Salesforce Bulk API 2.0 micro-batches) would be mandatory instead of individual record-level REST calls.

2. **Payload Scope (Changed Fields vs. Full Record):**
   * *Assumption:* Webhooks carry **changed fields only** (sparse diff) along with metadata (`eventId`, `recordId`, `objectType`, `occurredAt`, `changedBy`, `changedFields`), matching the sample webhook in the brief.
   * *Reversal Impact:* If webhooks carried full records, the inbound processor would have to compute a server-side diff against the stored PostgreSQL state before applying field-level timestamp evaluations, consuming additional CPU and read IOPS, but removing the need for fallback lookups when validating foreign-key relationships.

3. **Catch-up for Lost Webhooks During 6-Hour Outage:**
   * *Assumption:* We assume Salesforce webhooks that failed or were dropped during the 6-hour outage can be backfilled by querying Salesforce's `getUpdated()` API or a SOQL query (`SELECT ... WHERE SystemModstamp >= :outage_start`) once connectivity resumes.
   * *Reversal Impact:* If Salesforce does not persist dropped webhooks and provides no delta-query API (data is permanently gone unless delivered in the webhook), we would be forced to run a full 5-million-record batch diff or accept eventual consistency drift until a user manually touches the record.

4. **Concurrent Portal Users Editing the Same Field:**
   * *Assumption:* Portal edits use database transactions with optimistic concurrency control (`updated_at` / version check) at the API layer. The second save receives the latest state or overwrites based on Last-Write-Wins (LWW) using the server's monotonic clock.
   * *Reversal Impact:* If business requirements demand pessimistic row-locking or merge modals (prompting "User B changed this city to Noida while you were editing; keep yours or accept theirs?"), the portal UI and backend would require a distributed lock manager (e.g., Redis Redlock) and interactive conflict resolution endpoints.

5. **Portal Edit Ordering & Timestamp Authority:**
   * *Assumption:* Since portal save payloads have no user-provided timestamp, the **portal API server assigns the timestamp (`occurred_at = CLOCK_TIMESTAMP()`) at the moment the transaction commits in PostgreSQL**. The actor is extracted from the authenticated session JWT (`req.user.email`).
   * *Reversal Impact:* If client device timestamps were trusted instead, clock drift between user laptops would corrupt ordering, requiring vector clocks or TrueTime-style NTP uncertainty windows.

6. **Salesforce Integration User Identity:**
   * *Assumption:* Outbound API calls from the portal to Salesforce authenticate using a dedicated API integration user (`tequity.sync.service@client.example`).
   * *Reversal Impact:* If outbound calls impersonate the individual portal user in Salesforce, loop prevention cannot rely on `changedBy` and must instead rely on a custom Salesforce field (`Last_Sync_Mutation_Id__c`) echoed back in the webhook.

---

## 2. Systems, Boundaries, Interfaces & Protocol Contracts

```
 +---------------------------------------------------------------------------------------+
 |                                  PUBLIC INTERNET                                      |
 |                                                                                       |
 |  Salesforce CRM (Client)                                  Tequity Portal (Our Side)   |
 |  +-----------------------+                              +---------------------------+ |
 |  | Sales Users           |                              | Finance & CS Users        | |
 |  | Salesforce Database   |                              | Operations Web App        | |
 |  +-----------+-----------+                              +-------------+-------------+ |
 |              |                                                        |               |
 |              | (A) Inbound Webhook (HTTPS POST)                       | (Writes)      |
 |              |     event: evt_*, occurredAt, diff                     v               |
 |              +-----------------------------------------> [ Portal Webhook Service ]   |
 |                                                                       |               |
 |                                                                       | (ACID TX)     |
 |                                                                       v               |
 |                                                                +--------------+       |
 |                                                                |  PostgreSQL  |       |
 |                                                                | (5M records, |       |
 |                                                                |  Outbox,     |       |
 |                                                                |  Audit Log)  |       |
 |                                                                +-------+------+       |
 |                                                                        |              |
 |              | (B) Outbound REST API (HTTPS PATCH/POST)                | (Polls)      |
 |              |     Record API <= 100 req/sec                           v              |
 |              <----------------------------------------- [ Portal Sync Worker ]        |
 |                                                                                       |
 +---------------------------------------------------------------------------------------+
```

### 2.1 The Two Internal Components (Separation of Concerns)
We choose a **two-service architecture** connected by PostgreSQL as the durable queue:
1. **Webhook Endpoint Service (Inbound Producer/Consumer):** High-availability, stateless HTTP server. Accepts incoming webhooks, deduplicates, executes field-level merge into PostgreSQL, logs to audit history, and returns `200 OK` within 50ms.
2. **Sync Worker (Outbound Consumer/Dispatcher):** Background worker that reads from the `outbox_events` table, enforces the 100 req/sec Salesforce rate limit via a token bucket, and dispatches HTTPS REST calls.

**What crosses the boundary between them:**
* Zero inter-process RPC. The boundary is mediated purely through **PostgreSQL ACID transactions**.
* Portal edits write to `outbox_events`. Inbound webhooks update records and write to `inbound_events` and `record_audit_log` without creating `outbox_events`.

### 2.2 Interface Specifications

#### Inbound Webhook Interface (`POST /api/v1/webhooks/salesforce`)
* **Headers:** `X-Salesforce-Signature`, `Content-Type: application/json`
* **Payload:**
```json
{
  "eventId": "evt_1001",
  "recordId": "0031A00000Abc",
  "objectType": "Contact",
  "occurredAt": "2026-11-02T11:30:04.000Z",
  "changedBy": "sales.user@client.example",
  "changedFields": {
    "phone": "+919876543210"
  }
}
```
* **Responses:**
  * `200 OK`: Accepted & processed (or duplicate acknowledged).
  * `400 Bad Request`: Schema validation error (unrecognized object/field).
  * `401 Unauthorized`: Invalid webhook HMAC signature.
  * `500 Internal Error`: Database unavailable (Salesforce will retry with exponential backoff).

#### Outbound Salesforce API Interface (`PATCH /services/data/v59.0/sobjects/{type}/{id}`)
* **Rate Cap:** Maximum 100 requests/second strictly enforced across all workers.
* **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
* **Payload:**
```json
{
  "City__c": "Noida"
}
```
* **Responses:**
  * `204 No Content`: Update successful.
  * `429 Too Many Requests` / `503 Service Unavailable`: Rate limited or Salesforce down. Worker throttles and enters exponential backoff with jitter.

---

## 3. Subproblems in Order of Risk & Implementation

To build incrementally and de-risk early, we order the subproblems by risk:

```
Subproblem 1: Storage & Field-Level Concurrency Model [HIGHEST RISK]
   ├── Why first: 5M records with concurrent dual-system edits will corrupt silently 
   │   without field-level timestamps and immutable audit records.
   └── Component added: PostgreSQL schema, field metadata tracking, audit log.

Subproblem 2: Inbound Idempotency & Out-of-Order Handling [HIGH RISK]
   ├── Why second: Webhooks are inherently at-least-once and unordered over the public internet.
   └── Component added: Inbound Webhook Service, deduplication table, field-level LWW engine.

Subproblem 3: Outbound Durability & Rate Limiting (Outbox Engine) [HIGH RISK]
   ├── Why third: 100 req/s API hard cap and crashes during dispatch must never lose edits.
   └── Component added: Transactional Outbox pattern, Token Bucket Rate Limiter, Sync Worker.

Subproblem 4: Sync Loop Suppression [MEDIUM RISK]
   ├── Why fourth: Without loop suppression, updates echo endlessly between systems.
   └── Component added: Integration Actor identification and origin tagging.

Subproblem 5: 6-Hour Outage Resilience & Backlog Drain [MEDIUM RISK]
   ├── Why fifth: Depends on Subproblems 3 and 4 being rock-solid.
   └── Component added: Exponential backoff, persistent queue recovery, reconciliation poller.
```

---

## 4. The Data Stored (PostgreSQL Schema)

The schema stores 5,000,000 records, tracks field-level modification timestamps, guarantees idempotency, preserves complete audit history, and maintains the transactional outbox.

```sql
-- 1. Customers Table (Account equivalent)
CREATE TABLE customers (
    id VARCHAR(36) PRIMARY KEY,                  -- Salesforce Account ID or Portal UUID
    salesforce_id VARCHAR(18) UNIQUE,             -- 18-char SFDC Id
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,                  -- 'Active', 'Prospect', 'Churned'
    owner VARCHAR(255) NOT NULL,
    -- Field-level modification timestamps for Last-Write-Wins (LWW)
    name_updated_at TIMESTAMPTZ NOT NULL,
    status_updated_at TIMESTAMPTZ NOT NULL,
    owner_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- 2. Contacts Table
CREATE TABLE contacts (
    id VARCHAR(36) PRIMARY KEY,                  -- Salesforce Contact ID or Portal UUID
    salesforce_id VARCHAR(18) UNIQUE,             -- 18-char SFDC Id
    customer_id VARCHAR(36) REFERENCES customers(id),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    city VARCHAR(100),
    owner VARCHAR(255) NOT NULL,
    -- Field-level modification timestamps for LWW
    full_name_updated_at TIMESTAMPTZ NOT NULL,
    phone_updated_at TIMESTAMPTZ NOT NULL,
    email_updated_at TIMESTAMPTZ NOT NULL,
    city_updated_at TIMESTAMPTZ NOT NULL,
    owner_updated_at TIMESTAMPTZ NOT NULL,
    customer_id_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- 3. Inbound Webhook Deduplication Table (Idempotency)
CREATE TABLE inbound_events (
    event_id VARCHAR(128) PRIMARY KEY,           -- 'evt_1001'
    record_id VARCHAR(36) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
    payload JSONB NOT NULL
);

-- 4. Immutable Audit History Log (Preserving complete edit history)
CREATE TABLE record_audit_log (
    id BIGSERIAL PRIMARY KEY,
    record_id VARCHAR(36) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    field_name VARCHAR(50) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by VARCHAR(255) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,            -- Event timestamp
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
    source VARCHAR(20) NOT NULL                  -- 'SALESFORCE_WEBHOOK' or 'PORTAL_USER'
);

-- 5. Outbound Transactional Outbox (Durable queue on disk)
CREATE TABLE outbox_events (
    id BIGSERIAL PRIMARY KEY,
    record_id VARCHAR(36) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    operation VARCHAR(20) NOT NULL,              -- 'CREATE' or 'UPDATE'
    payload JSONB NOT NULL,                      -- { "city": "Noida" }
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'SENT', 'FAILED'
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- Performance Indexes for 5 Million Records Scale:
CREATE INDEX idx_contacts_salesforce_id ON contacts(salesforce_id);
CREATE INDEX idx_contacts_customer_id ON contacts(customer_id);
CREATE INDEX idx_audit_record_id ON record_audit_log(record_id, field_name);
CREATE INDEX idx_outbox_pending ON outbox_events(status, next_retry_at) WHERE status IN ('PENDING', 'FAILED');
```

---

## 5. The Inbound Path (Webhook to PostgreSQL)

```
[Salesforce] --(HTTPS POST)--> [Webhook Ingest Endpoint]
                                       |
                   +-------------------+-------------------+
                   | 1. Check Signature & Parse Payload    |
                   | 2. Check Loop Prevention (changedBy)  |
                   +-------------------+-------------------+
                                       |
                                       v
                    BEGIN TRANSACTION (Postgres)
                                       |
                   +-------------------+-------------------+
                   | 3. INSERT INTO inbound_events         |
                   |    ON CONFLICT (event_id) DO NOTHING  |
                   |    -> If already exists: COMMIT & 200 |
                   +-------------------+-------------------+
                                       |
                   +-------------------+-------------------+
                   | 4. SELECT record FOR UPDATE           |
                   |    For each changed field in payload: |
                   |    - Compare occurredAt > field_upd_at|
                   |    - If TRUE:                         |
                   |        apply update to column         |
                   |        set field_updated_at = occurred|
                   |        INSERT INTO record_audit_log   |
                   |    - If FALSE (out-of-order):         |
                   |        drop update                    |
                   |        INSERT INTO record_audit_log   |
                   |        (marked superseded)            |
                   +-------------------+-------------------+
                                       |
                    COMMIT TRANSACTION -> Return 200 OK
```

### Steps:
1. **Signature & Schema Verification:** Validate `X-Salesforce-Signature` HMAC. Parse JSON.
2. **Loop Filter:** If `changedBy == 'tequity.sync.service@client.example'`, drop immediately without updating outbox (see Section 9).
3. **Idempotency Check:** Atomically attempt `INSERT INTO inbound_events (event_id, ...)`. If conflict on `event_id`, this is a duplicate webhook. Return `200 OK` immediately.
4. **Row Lock & Field-Level Merge:** Acquire `SELECT ... FOR UPDATE` on the record.
5. **Timestamp Comparison & Audit:** For each field in `changedFields`, check whether `occurredAt > field_updated_at`. If newer, update column and update timestamp. Append old and new values to `record_audit_log`.
6. **Commit:** Commit transaction and respond `200 OK` in < 30ms.

---

## 6. The Outbound Path (Portal Edit to Salesforce API)

```
[Portal User] --(Save Form)--> [Portal API Server]
                                       |
                    BEGIN TRANSACTION (Postgres)
                                       |
                   +-------------------+-------------------+
                   | 1. Assign timestamp = CLOCK_TIMESTAMP|
                   | 2. UPDATE contact SET ...             |
                   | 3. INSERT INTO record_audit_log       |
                   | 4. INSERT INTO outbox_events          |
                   |    (record_id, payload, 'PENDING')    |
                   +-------------------+-------------------+
                                       |
                    COMMIT TRANSACTION -> Return 200 to user
                                       |
                          (Asynchronous Processing)
                                       v
                   +-------------------+-------------------+
                   | 5. Sync Worker Polls Outbox           |
                   |    SELECT ... FOR UPDATE SKIP LOCKED  |
                   +-------------------+-------------------+
                                       |
                   +-------------------+-------------------+
                   | 6. Rate Limiter Check (Token Bucket)  |
                   |    Enforce <= 100 req/sec cap         |
                   +-------------------+-------------------+
                                       |
                   +-------------------+-------------------+
                   | 7. HTTPS PATCH to Salesforce CRM API  |
                   |    - Success: mark outbox 'SENT'      |
                   |    - 429/503: mark 'FAILED', backoff  |
                   +-------------------+-------------------+
```

### Steps:
1. **User Action:** Finance user saves city = `"Noida"`.
2. **Atomic Write (Transactional Outbox Pattern):**
   * Assign `occurred_at = CLOCK_TIMESTAMP()`.
   * Update `contacts.city = 'Noida'`, `contacts.city_updated_at = occurred_at`.
   * Insert audit row in `record_audit_log`.
   * Insert event in `outbox_events` with status `'PENDING'`.
   * **Commit transaction.** The user gets an immediate success response. No HTTP calls are made inside the web transaction.
3. **Sync Worker Consumption:**
   * Sync worker queries `SELECT * FROM outbox_events WHERE status IN ('PENDING', 'FAILED') AND next_retry_at <= NOW() ORDER BY id ASC LIMIT 50 FOR UPDATE SKIP LOCKED`.
4. **Token Bucket Rate Limiting:**
   * Before dispatching, the worker acquires a token from a strict Token Bucket configured at **80 tokens/sec** (capacity 80, refill rate 80/sec, leaving a 20 req/s safety cushion under the 100 cap).
5. **Salesforce API Dispatch:**
   * Call Salesforce Record API over HTTPS.
   * On `200/204`: Mark outbox event `'SENT'`.
   * On `429/500/503`: Compute exponential backoff with full jitter: $t_{\text{wait}} = \min(300, 2^{\text{attempts}} \times 1.5) + \text{rand}(0, 1)$, update `next_retry_at`, keep as `'FAILED'`.

---

## 7. The Rule When Both Sides Change the Same Record

Two people may edit the same record simultaneously (e.g., Sales user in Salesforce, Finance user in Portal).

### Case A: Edits to Different Fields
* *Scenario:* Finance user edits `city = "Noida"` at 11:30:00. Sales user edits `phone = "+919876543210"` at 11:30:02.
* *Rule:* **Both edits survive.** Because our data model maintains discrete column-level updates and field-specific timestamps (`city_updated_at` and `phone_updated_at`), the inbound webhook updates only `phone` without touching `city`. The outbound call sends only `city` without overwriting `phone`.

### Case B: Edits to the Same Field (Conflict Resolution)
* *Scenario:* Finance user edits `city = "Noida"` at 11:30:01.000Z. Sales user edits `city = "Gurugram"` at 11:30:01.500Z.
* *Rule:* **Field-Level Last-Write-Wins (LWW) based on `occurred_at` timestamp.**
  * The edit with the strictly greater timestamp becomes the current active value in both systems.
  * If timestamps are identical to the millisecond, tie-breaker rule: **Salesforce wins** (system of record for CRM entities).
* *Audit Guarantee:* Regardless of which value is current, **earlier edits are never lost**. Both the losing edit and the winning edit exist as separate immutable rows in `record_audit_log`:
  ```
  [Audit Log Record]:
  - 11:30:01.000Z | city | Delhi -> Noida    | finance.user@client | PORTAL_USER
  - 11:30:01.500Z | city | Noida -> Gurugram | sales.user@client   | SALESFORCE_WEBHOOK
  ```

---

## 8. Rules for Duplicate & Out-of-Order Webhooks

### 8.1 Duplicate Webhook Rule (Idempotency)
Salesforce guarantees *at-least-once* delivery, meaning network retries can send `evt_1001` multiple times.
* **Rule:** An inbound event is processed **exactly once**.
* **Mechanism:**
  ```sql
  INSERT INTO inbound_events (event_id, record_id, object_type, occurred_at, payload)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (event_id) DO NOTHING;
  ```
  If `INSERT` affects 0 rows, the worker halts processing, logs `duplicate_webhook_ignored`, and returns `200 OK` to Salesforce immediately.

### 8.2 Out-of-Order Webhook Rule (Causality Enforcement)
Because webhooks travel over the public internet, a change made at 11:30:04Z can arrive *after* a change made at 11:30:10Z.
* *Scenario:*
  * Event 2 (`occurredAt: 11:30:10Z`, `city: "Mumbai"`) arrives first. Current `city` becomes `"Mumbai"`, `city_updated_at` = 11:30:10Z.
  * Event 1 (`occurredAt: 11:30:04Z`, `city: "Delhi"`) arrives second.
* **Rule:** **Stale Field Rejection with Audit Preservation.**
  * Inbound processor evaluates:
    $$\text{incoming}.\text{occurredAt} > \text{current}.\text{city\_updated\_at}$$
  * $11:30:04\text{Z} > 11:30:10\text{Z}$ is **FALSE**.
  * The update to `contacts.city` is **suppressed/dropped**. Current value remains `"Mumbai"`.
  * The event is written to `record_audit_log` with `new_value = "Delhi"`, `status = "SUPERSEDED_OUT_OF_ORDER"` to preserve the historical fact of the edit without corrupting current state.

---

## 9. The Rule That Stops a Loop (Ping-Pong Prevention)

Without loop prevention, when the Portal sends an update to Salesforce, Salesforce fires a webhook describing that change, which the Portal receives and interprets as an edit, queuing another call to Salesforce, bouncing indefinitely.

```
[Portal User] -> Portal DB -> Outbox -> Call SF API
                                            |
                                            v
                                      Salesforce CRM
                                            | (Emits Webhook)
                                            v
                                   Webhook Endpoint
                                            |
                      [ LOOP PREVENTION FILTER APPLIED ]
                      Is changedBy == tequity.sync.service?
                             /                \
                           YES                 NO
                           /                     \
             [ Suppress Outbox ]          [ Enqueue Outbox ]
             Update DB & stop.            Sync to Salesforce.
```

### The Prevention Mechanism:
1. **Dedicated Service Identity:** All calls made by the Portal Sync Worker to Salesforce use OAuth credentials for a dedicated user: `tequity.sync.service@client.example`.
2. **Webhook Actor Inspection:** When Salesforce fires a webhook, it includes `changedBy`.
3. **Suppression Rule:**
   * If `changedBy === 'tequity.sync.service@client.example'`, the webhook is recognized as an echo of our own outbound write.
   * The webhook handler updates `field_updated_at` and stores audit entries, but **does NOT insert any row into `outbox_events`**.
   * The cycle terminates immediately with zero outbound side-effects.

---

## 10. The 6-Hour Outage: State, Backlog Drain & Exact Arithmetic

### 10.1 What is on Disk During the Outage?
When the Salesforce API goes dark for 6 hours:
1. **Portal users continue working uninterrupted:** All portal saves are accepted, committed locally to PostgreSQL, and safely appended to `outbox_events` with status `'FAILED'` / `'PENDING'`.
2. **Crash Resilience:** Because `outbox_events` resides on PostgreSQL durable disk storage (WAL + table), even if the portal servers or worker processes restart multiple times during the 6-hour window, **zero writes are lost**.
3. **Worker Behavior:** The sync worker detects consecutive connection timeouts / 503s from Salesforce, activates circuit breaker mode, and backs off polling interval to 30 seconds.

### 10.2 The Arithmetic: Backlog Accumulation & Drain Time

#### Workload Parameters:
* **Outage Duration ($T$):** 6 hours = $6 \times 3,600 = \mathbf{21,600\text{ seconds}}$.
* **Salesforce Hard Rate Cap ($C$):** $100\text{ req/sec}$.
* **Our Worker Operating Rate ($R_{\text{worker}}$):** Set to **$80\text{ req/sec}$** (leaving a 20 req/s cushion for retry headroom and live traffic bursts).

#### Scenario 1: Peak Edit Workload
* **Peak Edit Rate ($E_{\text{peak}}$):** $10\text{ edits/second}$.
* **Total Backlog Accumulated ($B_{\text{peak}}$):**
  $$B_{\text{peak}} = E_{\text{peak}} \times T = 10\text{ edits/sec} \times 21,600\text{ sec} = \mathbf{216,000\text{ edits}}.$$
* **Incoming Live Edits during catch-up:** While draining, portal users continue creating new edits at $E_{\text{peak}} = 10\text{ edits/sec}$.
* **Effective Net Drain Velocity ($V_{\text{net}}$):**
  $$V_{\text{net}} = R_{\text{worker}} - E_{\text{peak}} = 80 - 10 = \mathbf{70\text{ edits/sec}}.$$
* **Exact Drain Time ($D_{\text{peak}}$):**
  $$D_{\text{peak}} = \frac{B_{\text{peak}}}{V_{\text{net}}} = \frac{216,000\text{ edits}}{70\text{ edits/sec}} = 3,085.71\text{ seconds}.$$
* **In Minutes:**
  $$\frac{3,085.71}{60} = \mathbf{51.43\text{ minutes}} \quad (\approx \mathbf{51\text{ minutes } 26\text{ seconds}}).$$

#### Scenario 2: Quiet Workload (e.g., Night / Weekend Outage)
* **Quiet Edit Rate ($E_{\text{quiet}}$):** $0.5\text{ edits/second}$.
* **Total Backlog Accumulated ($B_{\text{quiet}}$):**
  $$B_{\text{quiet}} = 0.5 \times 21,600 = \mathbf{10,800\text{ edits}}.$$
* **Effective Net Drain Velocity:**
  $$V_{\text{net}} = 80 - 0.5 = 79.5\text{ edits/sec}.$$
* **Exact Drain Time ($D_{\text{quiet}}$):**
  $$D_{\text{quiet}} = \frac{10,800}{79.5} = 135.85\text{ seconds} = \mathbf{2.26\text{ minutes}}.$$

#### Coalescing Optimization (Reducing Total Outbound Calls):
If the same contact is modified 5 times during the 6-hour outage (e.g., city updated multiple times), the sync worker executes a coalescing query upon wake-up:
$$\text{SELECT DISTINCT ON (record\_id) ...}$$
If 20% of edits target identical records during the 6-hour window, the backlog of 216,000 drops to $\approx 172,800$ requests, reducing peak drain time to:
$$\frac{172,800}{70 \times 60} = \mathbf{41.14\text{ minutes}}.$$

---

## 11. Three Operational Metrics & PagerDuty Thresholds

To maintain visibility and sleep at night, we track these 3 key indicators:

| Metric | Normal Value | PagerDuty Warning Threshold | PagerDuty Critical Page Threshold | Actionable Remediation |
| :--- | :--- | :--- | :--- | :--- |
| **1. Outbox Queue Lag (Pending Age)** | $< 10\text{ seconds}$ | $> 30\text{ seconds}$ for 3 mins | **$> 120\text{ seconds}$** | Indicates sync worker stall or network partition to Salesforce API. Check Salesforce Status page, verify API token validity. |
| **2. Inbound Webhook 5xx Error Rate** | $0\%$ | $> 0.5\%$ over 5 mins | **$> 2.0\%$ over 2 mins** | Indicates PostgreSQL database locking, disk saturation, or deadlocks on `contacts` table. Scale DB connections or check lock contention. |
| **3. Salesforce API 429 Quota Rate** | $0\text{ req/sec}$ | $> 1\text{ req/sec}$ | **$> 5\text{ req/sec}$ for 1 min** | We are violating or nearing the 100 req/sec cap. Automatically throttle token bucket from 80 req/s down to 50 req/s; alert on-call engineer. |

---

## 12. Scope Exclusions (What is Left Out This Weekend)

In strict accordance with the constraints of the exercise, the following areas are omitted from this implementation:
1. **Record Deletions / Cascades:** Neither Salesforce `delete` webhooks nor portal `DELETE` endpoints are implemented. Records are assumed soft-deleted or append/update only.
2. **Salesforce OAuth Login Screens:** Authentication uses pre-configured static integration bearer tokens / secrets rather than interactive user OAuth authorization flows.
3. **Visual Frontend GUI:** No React/HTML UI is constructed; all portal interactions are driven via authenticated REST API requests and automated verification harnesses.
4. **Multi-Region Active-Active Replication:** We run a single-region PostgreSQL cluster with standard read-replica failover, rather than a multi-region distributed Spanner setup.
5. **Live Load Testing against Production Salesforce:** Verification is executed against our deterministic mock Salesforce CRM engine matching Salesforce's exact HTTP protocol, rate limits, and failure modes.
