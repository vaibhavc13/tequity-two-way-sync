# Two-Way Sync Engine: Customers & Contacts (Salesforce $\leftrightarrow$ Tequity Operations Portal)
## Round 1 Engineering Submission

---

### Deliverables Quick Links
1. **[Design Document (DESIGN.md)](./DESIGN.md)**: Full architecture document structured in the exact 12-section outline required by the specification.
2. **[AI Interaction Transcript (AI_CHAT_HISTORY.md)](./AI_CHAT_HISTORY.md)**: Complete dialogue and prompting progression showing risk decomposition, architectural pushbacks, mathematical corrections, and edge-case diagnosis.
3. **TypeScript Reference Implementation (`src/` & `test/`)**: Complete, zero-dependency Node.js (v20+) implementation proving all four edge cases.

---

## 1. Quick Start & Testing Guide

This project provides **three complementary ways to test and verify** the sync engine:

```
Testing Options
 ├── Method 1: Automated Unit Tests      (`npm test`)      -> 8 isolated unit tests in 5 suites
 ├── Method 2: End-to-End Live Demo      (`npm start`)     -> Sequential 1-command verification
 └── Method 3: Live Manual HTTP Server   (`npm run server`) -> Interactive testing with curl / browser
```

### Initial Setup
In your terminal, navigate to the project directory and install the development dependencies:
```bash
cd C:\Users\niveus\.gemini\antigravity\scratch\tequity-two-way-sync
npm install
```

---

### Method 1: Automated Unit Test Suite (`npm test`)

Runs 8 formal, isolated unit tests using **Node.js's native test runner** (`node:test` and `node:assert`). Requires zero external test packages and runs in under 300ms.

```bash
npm test
```

#### What It Verifies:
* `test/idempotency.test.ts`: Verifies `eventId` primary key deduplication, idempotent return codes, and 0 duplicate database/audit writes.
* `test/causality.test.ts`: Proves stale out-of-order events are dropped from current columns but preserved in audit history; proves simultaneous edits to different fields both survive.
* `test/loop-prevention.test.ts`: Proves webhooks from `tequity.sync.service@client.example` create exactly 0 outbound outbox events.
* `test/outbox-durability.test.ts`: Simulates CRM 503 outage, accumulates edits on disk, performs a **hard process termination and reboot**, proves all items survive on disk, and verifies rate-limited backlog drain.
* `test/rate-limiter.test.ts`: Tests burst capacity and verifies precise time-based request pacing.

---

### Method 2: End-to-End Live Demo (`npm start` or `npm run demo`)

Executes a complete sequential scenario with verbose visual terminal logging covering all 4 problem rules:

```bash
npm start
```

#### Live Demo Flow:
1. **Setup:** Initializes Contact `0031A00000Abc` with baseline data.
2. **Check 1 (Idempotency):** Delivers `evt_1001` twice. Second delivery returns `DUPLICATE_IGNORED` with 0 duplicate DB writes.
3. **Check 2 (Out-of-Order Delivery):** Delivers newer edit (`11:30:10Z` $\to$ Mumbai) before older edit (`11:30:04Z` $\to$ Noida). Mumbai stays active; Noida is recorded in audit log as `SUPERSEDED_OUT_OF_ORDER`.
4. **Check 3 (Loop Suppression):** Portal user saves city $\to$ worker syncs to Salesforce $\to$ Salesforce reflects echo webhook $\to$ engine suppresses echo and creates 0 outbound events.
5. **Check 4 (6-Hour Outage & Restart):** Fake Salesforce returns HTTP 503. 15 edits saved locally on disk. Engine process is terminated and re-instantiated from disk. All 15 outbox items survive and drain safely under the rate limiter.

---

### Method 3: Live Interactive HTTP Server & Manual `curl` Testing (`npm run server`)

If the interviewers ask to test custom payloads live or inspect JSON responses in a browser, start the live HTTP server:

```bash
npm run server
```

The server listens on **`http://localhost:3000`**. Open a second terminal window (or browser/Postman) and run the following manual `curl` commands:

#### 1. View Current Record & Full Audit Trail (GET)
```bash
curl http://localhost:3000/api/contact/0031A00000Abc
```
*In your browser: navigate directly to `http://localhost:3000/api/contact/0031A00000Abc`.*

---

#### 2. Test Rule 1: Duplicate Webhook Delivery (POST)
Send a webhook with ID `evt_curl_100`:
```bash
curl -X POST http://localhost:3000/api/webhooks/salesforce \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_curl_100","recordId":"0031A00000Abc","objectType":"Contact","occurredAt":"2026-11-25T12:00:00.000Z","changedBy":"sales@client.example","changedFields":{"phone":"+919876543210"}}'
```
*Response on First Call:*
```json
{ "status": "SUCCESS", "appliedFields": ["phone"], "supersededFields": [] }
```

*Run the exact same command a second time:*
```json
{ "status": "DUPLICATE_IGNORED", "details": "Event evt_curl_100 already processed. Acknowledged without re-applying." }
```

---

#### 3. Test Rule 2: Out-of-Order Webhooks (POST)
Send a newer edit first (`12:10:00Z` $\to$ city = `"Mumbai"`):
```bash
curl -X POST http://localhost:3000/api/webhooks/salesforce \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_new","recordId":"0031A00000Abc","objectType":"Contact","occurredAt":"2026-11-25T12:10:00.000Z","changedBy":"sales@client.example","changedFields":{"city":"Mumbai"}}'
```
*Response:* `"status": "SUCCESS"`.

Now send a delayed older edit second (`12:05:00Z` $\to$ city = `"Noida"`):
```bash
curl -X POST http://localhost:3000/api/webhooks/salesforce \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_old","recordId":"0031A00000Abc","objectType":"Contact","occurredAt":"2026-11-25T12:05:00.000Z","changedBy":"sales@client.example","changedFields":{"city":"Noida"}}'
```
*Response:* `"status": "OUT_OF_ORDER_DROPPED"`, `"supersededFields": ["city"]`.  
Check `http://localhost:3000/api/contact/0031A00000Abc`: city remains `"Mumbai"`, while `"Noida"` is recorded in audit history under `SUPERSEDED_OUT_OF_ORDER`.

---

#### 4. Test Rule 3: Sync Loop Prevention (POST)
Send a webhook with `changedBy = "tequity.sync.service@client.example"`:
```bash
curl -X POST http://localhost:3000/api/webhooks/salesforce \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_echo","recordId":"0031A00000Abc","objectType":"Contact","occurredAt":"2026-11-25T12:15:00.000Z","changedBy":"tequity.sync.service@client.example","changedFields":{"city":"Mumbai"}}'
```
*Response:*
```json
{ "status": "LOOP_ECHO_SUPPRESSED", "details": "Webhook originated from portal sync user (tequity.sync.service@client.example). Update accepted locally but outbound sync suppressed." }
```

---

#### 5. Test Portal Edit & Transactional Outbox (POST)
Simulate a portal finance user editing the contact:
```bash
curl -X POST http://localhost:3000/api/portal/edit \
  -H "Content-Type: application/json" \
  -d '{"recordId":"0031A00000Abc","objectType":"Contact","editedBy":"finance.user@client.example","changedFields":{"city":"Bengaluru"}}'
```
*Response:* `"success": true`, `"outboxId": 1`.

Check pending queue status:
```bash
curl http://localhost:3000/api/status
```
*Response shows `pendingOutboxCount: 1`.*

Trigger worker to drain to Salesforce:
```bash
curl -X POST http://localhost:3000/api/sync/drain
```
*Response shows `successCount: 1`. Calling `/api/status` now shows `pendingOutboxCount: 0`.*

---

#### 6. Test Rule 4: Salesforce Outage & Retry Backoff (POST)
Toggle Salesforce 6-hour outage mode:
```bash
curl -X POST http://localhost:3000/api/salesforce/outage \
  -H "Content-Type: application/json" \
  -d '{"outage": true}'
```
*Response: `{ "salesforceOutage": true }`.*

Save a portal edit while Salesforce is down:
```bash
curl -X POST http://localhost:3000/api/portal/edit \
  -H "Content-Type: application/json" \
  -d '{"recordId":"0031A00000Abc","objectType":"Contact","editedBy":"finance.user@client.example","changedFields":{"city":"Saved_During_Outage"}}'
```

Attempt worker sync:
```bash
curl -X POST http://localhost:3000/api/sync/drain
```
*Response shows `failedCount: 1` with exponential backoff scheduled. Edit remains safely on disk!*

Turn Salesforce back online and drain:
```bash
curl -X POST http://localhost:3000/api/salesforce/outage -H "Content-Type: application/json" -d '{"outage": false}'
curl -X POST http://localhost:3000/api/sync/drain
```
*Backlog cleared to Salesforce!*

---

## 2. Architecture Overview: Who Calls Whom

```
 Sales User                             Finance / Customer-Success User
     |                                                 |
     | Uses CRM                                        | Uses Operations Portal
     v                                                 v
 Salesforce CRM                                  Tequity Portal
 (Client App & Database)                         (Our Node.js Service)
     |                                                 |
     |                                                 v
     |                                            PostgreSQL
     |                                            (Our Database: 5M records,
     |                                             Outbox, Audit Log)
     |
     |   (A) Salesforce calls Us
     |       HTTPS Webhook (sparse diff)
     +----------------------------------------->  Portal Webhook Endpoint
     |                                            (Deduplication + Field LWW + Audit)
     |
     |   (B) We call Salesforce
     |       HTTPS Record API (PATCH/POST)
     <------------------------------------------  Portal Sync Worker
             create or update record              (Token Bucket <= 100 req/s)
```

---

## 3. The 6-Hour Outage Arithmetic: Exact Numbers & Division

* **Outage Duration ($T$):** 6 hours = $6 \times 3,600 = \mathbf{21,600\text{ seconds}}$.
* **Salesforce API Limit:** $100\text{ req/sec}$.
* **Our Safe Worker Rate ($R_{\text{worker}}$):** **$80\text{ req/sec}$** (leaving a 20 req/s safety cushion).

### Peak Workload Catch-Up:
* **Peak Edit Rate ($E_{\text{peak}}$):** $10\text{ edits/second}$.
* **Backlog Accumulated ($B_{\text{peak}}$):** $10 \times 21,600 = \mathbf{216,000\text{ edits}}$.
* **Net Drain Velocity ($V_{\text{net}}$):** $80 - 10 = \mathbf{70\text{ edits/second}}$ (accounting for ongoing live edits during catch-up).
* **Exact Drain Time ($D_{\text{peak}}$):**
  $$D_{\text{peak}} = \frac{216,000\text{ edits}}{70\text{ edits/sec}} = 3,085.71\text{ seconds} = \mathbf{51.43\text{ minutes}} \quad (51\text{m } 26\text{s}).$$

### Quiet Workload Catch-Up (Night / Weekend):
* **Quiet Edit Rate ($E_{\text{quiet}}$):** $0.5\text{ edits/second}$.
* **Backlog Accumulated ($B_{\text{quiet}}$):** $0.5 \times 21,600 = \mathbf{10,800\text{ edits}}$.
* **Net Drain Velocity:** $80 - 0.5 = 79.5\text{ edits/second}$.
* **Drain Time:** $\frac{10,800}{79.5} = 135.85\text{ seconds} = \mathbf{2.26\text{ minutes}}$.

---

## 4. 10-Minute Walkthrough Outline (Interview Script)

Use this minute-by-minute outline during the interview presentation:

* **0:00 – 2:00: Assumptions & Open Questions**
  * State 5M records, 10 edits/s peak, 0.5 quiet, sparse webhooks.
  * Reversal impacts: If peak > 100 req/s $\to$ Bulk API 2.0; if lost webhooks cannot be backfilled $\to$ full table nightly reconciliation diff.
* **2:00 – 4:00: System Boundaries & Architecture**
  * Present "Who calls whom" diagram.
  * Explain separation of Inbound Webhook Endpoint vs. Outbound Sync Worker via the **Transactional Outbox Pattern**.
* **4:00 – 7:00: The Four Core Distributed Rules**
  1. *Conflict Resolution:* Field-level timestamps (`city_updated_at`, `phone_updated_at`). Edits to different fields both survive; edits to same field resolve via LWW; all edits recorded in immutable `record_audit_log`.
  2. *Duplicate Webhook:* Idempotency table `inbound_events (event_id PRIMARY KEY)` with `ON CONFLICT DO NOTHING`.
  3. *Out-of-Order Delivery:* Causality check (`occurredAt > field_updated_at`). Stale edits dropped from active columns, kept in audit trail as `SUPERSEDED_OUT_OF_ORDER`.
  4. *Loop Suppression:* Dedicated API actor (`tequity.sync.service@client.example`) filters echo webhooks at the boundary.
* **7:00 – 8:30: Outage Recovery & The Arithmetic**
  * Walk through the net velocity calculation ($80 - 10 = 70\text{ req/s}$) and show the division resulting in $51.43\text{ minutes}$.
* **8:30 – 10:00: Observability & Live Demo**
  * Three numbers watched: Outbox lag (>120s page), Webhook 5xx rate (>2% page), Salesforce 429 rate (>5 req/s page).
  * Run `npm start` or show `npm run server` with curl outputs.
