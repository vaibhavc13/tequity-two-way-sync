import * as http from 'http';
import { DurableDatabase } from './db/storage.js';
import { FakeSalesforceCRM } from './services/fake-salesforce.js';
import { InboundWebhookHandler } from './services/inbound-webhook-handler.js';
import { PortalAPIService } from './services/portal-api.js';
import { OutboundSyncWorker } from './services/outbound-sync-worker.js';
import { TokenBucketRateLimiter } from './services/rate-limiter.js';

const PORT = 3000;
const db = new DurableDatabase('./.data_server');
const sfdc = new FakeSalesforceCRM();
const rateLimiter = new TokenBucketRateLimiter(20);
const inboundHandler = new InboundWebhookHandler(db);
const portalApi = new PortalAPIService(db);
const syncWorker = new OutboundSyncWorker(db, sfdc, rateLimiter);

function seedDefaultContact(): void {
  if (!db.getContact('0031A00000Abc')) {
    inboundHandler.processWebhook({
      eventId: 'evt_init',
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      occurredAt: '2026-11-20T10:00:00.000Z',
      changedBy: 'seed@client.example',
      changedFields: {
        fullName: 'Anita Roy',
        phone: '+919111111111',
        city: 'Delhi',
        owner: 'sales.rep@client.example',
      },
    });
  }
}

// Seed default contact if missing
seedDefaultContact();

function parseJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function getOpenApiSpec(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Tequity Two-Way Sync Engine API',
      version: '1.0.0',
      description:
        'REST API for the Two-Way Sync between Salesforce CRM and the Tequity Portal (PostgreSQL). Implements Webhook Deduplication (Rule 1), Field-Level Last-Write-Wins (Rule 2), Sync Loop Echo Suppression (Rule 3), and 6-Hour Outage Transactional Outbox (Rule 4).',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local Sync Server' }],
    paths: {
      '/api/contact/{id}': {
        get: {
          summary: 'Get Contact & Immutable Audit Trail',
          description: 'Fetch the active record state and its complete historical audit trail.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', default: '0031A00000Abc' },
            },
          ],
          responses: {
            '200': { description: 'Contact found with audit trail.' },
            '404': { description: 'Contact not found.' },
          },
        },
      },
      '/api/webhooks/salesforce': {
        post: {
          summary: 'Salesforce Inbound Webhook',
          description:
            'Simulate Salesforce sending an HTTPS webhook with changed fields. Demonstrates idempotency on duplicates, field-level LWW on out-of-order timestamps, and loop suppression on sync user writes.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    eventId: { type: 'string', example: 'evt_1001' },
                    recordId: { type: 'string', example: '0031A00000Abc' },
                    objectType: { type: 'string', example: 'Contact' },
                    occurredAt: { type: 'string', example: '2026-11-25T12:00:00.000Z' },
                    changedBy: { type: 'string', example: 'sales.user@client.example' },
                    changedFields: {
                      type: 'object',
                      example: { phone: '+919876543210', city: 'Mumbai' },
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Webhook processed.' } },
        },
      },
      '/api/portal/edit': {
        post: {
          summary: 'Portal User Edit (Transactional Outbox)',
          description:
            'Simulate a Finance or CS user saving an edit on the operations portal. Atomically updates PostgreSQL and enqueues an outbox task for Salesforce.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    recordId: { type: 'string', example: '0031A00000Abc' },
                    objectType: { type: 'string', example: 'Contact' },
                    editedBy: { type: 'string', example: 'finance.user@client.example' },
                    changedFields: {
                      type: 'object',
                      example: { city: 'Bengaluru' },
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Edit committed and queued in Outbox.' } },
        },
      },
      '/api/status': {
        get: {
          summary: 'System & Outbox Queue Status',
          description:
            'Inspect Salesforce outage mode, rate limiting, and the count of pending outbox events awaiting synchronization.',
          responses: { '200': { description: 'System health and queue status.' } },
        },
      },
      '/api/sync/drain': {
        post: {
          summary: 'Trigger Outbox Backlog Drain',
          description:
            'Instruct the background sync worker to drain pending outbox events to Salesforce CRM under the Token Bucket rate limit.',
          responses: { '200': { description: 'Drain completed.' } },
        },
      },
      '/api/salesforce/outage': {
        post: {
          summary: 'Toggle Salesforce 6-Hour Outage',
          description:
            'Simulate Salesforce returning HTTP 503 Service Unavailable or bring it back online to test crash durability and queue recovery.',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { outage: { type: 'boolean', example: true } },
                },
              },
            },
          },
          responses: { '200': { description: 'Outage state toggled.' } },
        },
      },
      '/api/reset': {
        post: {
          summary: 'Reset Demo State',
          description: 'Clears all stored records, inbound deduplication keys, outbox queue, and audit logs, then re-seeds the baseline Contact 0031A00000Abc.',
          responses: { '200': { description: 'Demo state reset to clean baseline.' } },
        },
      },
    },
  };
}

function getSwaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tequity Two-Way Sync API - Swagger UI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; font-family: sans-serif; }
    .topbar-nav { background: #1e293b; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; color: white; }
    .topbar-nav a { color: #38bdf8; text-decoration: none; font-weight: bold; font-size: 14px; margin-left: 16px; }
    .topbar-nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="topbar-nav">
    <span style="font-weight: 600; font-size: 16px;">Tequity Two-Way Sync Engine</span>
    <div>
      <a href="/">← Open 1-Click Interactive Dashboard</a>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: "/api/docs/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`;
}

function getHtmlDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tequity Two-Way Sync Control Panel</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 1100px; margin: 0 auto; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    h1 { color: #38bdf8; margin: 0; }
    .swagger-btn { background: #0284c7; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; }
    .swagger-btn:hover { background: #0369a1; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 20px; }
    .card h2 { margin-top: 0; font-size: 18px; color: #e2e8f0; border-bottom: 1px solid #334155; padding-bottom: 10px; }
    .btn { display: inline-block; width: 100%; padding: 10px 14px; margin-bottom: 10px; background: #0284c7; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; text-align: left; font-size: 13px; transition: background 0.15s; }
    .btn:hover { background: #0369a1; }
    .btn-warn { background: #d97706; }
    .btn-warn:hover { background: #b45309; }
    .btn-danger { background: #e11d48; }
    .btn-danger:hover { background: #be123c; }
    .btn-success { background: #16a34a; }
    .btn-success:hover { background: #15803d; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; color: #a5f3fc; line-height: 1.4; border: 1px solid #1e293b; }
    .status-badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .status-online { background: #166534; color: #86efac; }
    .status-outage { background: #991b1b; color: #fca5a5; }
    .badge-wrap { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #334155; padding: 6px 8px; text-align: left; }
    th { background: #0f172a; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <h1>Two-Way Sync Interactive Control Panel</h1>
      <div>
        <a href="/design" class="swagger-btn" style="margin-right: 10px; background: #334155;">📄 View DESIGN.md</a>
        <a href="/docs" class="swagger-btn">📖 Open Swagger UI</a>
      </div>
    </div>
    <div class="subtitle">Simulate real-time Salesforce Webhooks, Portal Edits, Outages, and Outbox Drains with 1 click.</div>

    <div class="grid">
      <div class="card">
        <h2>Simulate Actions (Click to Test)</h2>
        <p style="color: #94a3b8; font-size: 13px; margin-top: 0;"><b>Inbound from Salesforce:</b></p>
        <button class="btn" onclick="sendWebhookFresh()">1. Salesforce Webhook: Update Phone (+919876543210)</button>
        <button class="btn btn-warn" onclick="sendWebhookDuplicate()">2. Duplicate Webhook: Send Same Event Again (Rule 1)</button>
        <button class="btn btn-warn" onclick="sendWebhookOutOfOrder()">3. Out-of-Order Webhook: Send Stale Event (Rule 2)</button>
        <button class="btn" onclick="sendWebhookEcho()">4. Echo Webhook: From Sync User (Rule 3 Loop Suppression)</button>

        <p style="color: #94a3b8; font-size: 13px; margin-top: 15px;"><b>Outbound from Portal:</b></p>
        <button class="btn btn-success" onclick="sendPortalEdit()">5. Portal Save: Finance changes City to "Bengaluru"</button>
        <button class="btn btn-danger" onclick="toggleOutage()">6. Toggle Salesforce 6-Hour Outage (Rule 4)</button>
        <button class="btn btn-success" onclick="drainOutbox()">7. Drain Outbox Queue to Salesforce</button>
        <hr style="border:0; border-top:1px solid #334155; margin: 14px 0;">
        <button class="btn" style="background: #475569;" onclick="resetDemo()">🔄 Reset Demo Data (Fresh Start)</button>
      </div>

      <div class="card">
        <div class="badge-wrap">
          <h2 style="border: none; margin: 0; padding: 0;">Live System State</h2>
          <span id="outageBadge" class="status-badge status-online">Salesforce: ONLINE</span>
        </div>
        <p style="font-size: 13px; margin: 0 0 8px 0; color: #94a3b8;">Pending Outbox Items: <b id="outboxCount" style="color: #f8fafc;">0</b></p>
        <pre id="contactView">Loading contact record...</pre>

        <h3 style="font-size: 14px; margin: 15px 0 6px 0; color: #cbd5e1;">Last API Response:</h3>
        <pre id="lastResponse" style="max-height: 140px; color: #fde047;">(Click any button on the left to test)</pre>
      </div>
    </div>

    <div class="card" style="margin-top: 20px;">
      <h2>Immutable Audit Trail (History of all edits)</h2>
      <div style="overflow-x: auto; max-height: 240px;">
        <table id="auditTable">
          <thead>
            <tr>
              <th>ID</th>
              <th>Field</th>
              <th>Old Value</th>
              <th>New Value</th>
              <th>Changed By</th>
              <th>Source</th>
              <th>Status</th>
              <th>Occurred At</th>
            </tr>
          </thead>
          <tbody id="auditBody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const recordId = '0031A00000Abc';

    async function refreshData() {
      const res = await fetch('/api/contact/' + recordId);
      const data = await res.json();
      document.getElementById('contactView').textContent = JSON.stringify(data.contact, null, 2);
      
      const tbody = document.getElementById('auditBody');
      tbody.innerHTML = '';
      (data.auditLogs || []).forEach(log => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + log.id + '</td>' +
          '<td><b>' + log.fieldName + '</b></td>' +
          '<td style="color:#94a3b8;">' + (log.oldValue || 'null') + '</td>' +
          '<td style="color:#86efac;">' + (log.newValue || 'null') + '</td>' +
          '<td>' + log.changedBy + '</td>' +
          '<td>' + log.source + '</td>' +
          '<td><span style="color:' + (log.status==='APPLIED'?'#86efac':(log.status==='SUPERSEDED_OUT_OF_ORDER'?'#fca5a5':'#fde047')) + '">' + log.status + '</span></td>' +
          '<td style="font-size:10px;">' + log.occurredAt + '</td>';
        tbody.appendChild(tr);
      });

      const stRes = await fetch('/api/status');
      const st = await stRes.json();
      document.getElementById('outboxCount').textContent = st.pendingOutboxCount;
      const badge = document.getElementById('outageBadge');
      if (st.salesforceOutage) {
        badge.className = 'status-badge status-outage';
        badge.textContent = 'Salesforce: 503 OUTAGE';
      } else {
        badge.className = 'status-badge status-online';
        badge.textContent = 'Salesforce: ONLINE';
      }
    }

    async function handleAction(url, method, body) {
      const res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json();
      document.getElementById('lastResponse').textContent = JSON.stringify(data, null, 2);
      await refreshData();
    }

    let lastEventId = 'evt_ui_1';
    function sendWebhookFresh() {
      lastEventId = 'evt_ui_' + Date.now();
      handleAction('/api/webhooks/salesforce', 'POST', {
        eventId: lastEventId,
        recordId: recordId,
        objectType: 'Contact',
        occurredAt: new Date().toISOString(),
        changedBy: 'sales.user@client.example',
        changedFields: { phone: '+919876543210' }
      });
    }

    function sendWebhookDuplicate() {
      handleAction('/api/webhooks/salesforce', 'POST', {
        eventId: lastEventId,
        recordId: recordId,
        objectType: 'Contact',
        occurredAt: new Date().toISOString(),
        changedBy: 'sales.user@client.example',
        changedFields: { phone: '+919876543210' }
      });
    }

    function sendWebhookOutOfOrder() {
      handleAction('/api/webhooks/salesforce', 'POST', {
        eventId: 'evt_stale_' + Date.now(),
        recordId: recordId,
        objectType: 'Contact',
        occurredAt: '2026-11-01T10:00:00.000Z',
        changedBy: 'sales.user@client.example',
        changedFields: { city: 'Stale_Noida' }
      });
    }

    function sendWebhookEcho() {
      handleAction('/api/webhooks/salesforce', 'POST', {
        eventId: 'evt_echo_' + Date.now(),
        recordId: recordId,
        objectType: 'Contact',
        occurredAt: new Date().toISOString(),
        changedBy: 'tequity.sync.service@client.example',
        changedFields: { city: 'Bengaluru' }
      });
    }

    function sendPortalEdit() {
      handleAction('/api/portal/edit', 'POST', {
        recordId: recordId,
        objectType: 'Contact',
        editedBy: 'finance.user@client.example',
        changedFields: { city: 'Bengaluru' }
      });
    }

    function toggleOutage() {
      handleAction('/api/salesforce/outage', 'POST', {});
    }

    function drainOutbox() {
      handleAction('/api/sync/drain', 'POST', {});
    }

    function resetDemo() {
      lastEventId = 'evt_ui_1';
      handleAction('/api/reset', 'POST', {});
    }

    refreshData();
    setInterval(refreshData, 3000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  try {
    // 1. GET /docs or /swagger -> Serve Official Swagger UI
    if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/swagger')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(getSwaggerUiHtml());
    }

    // 1b. GET /design -> Beautiful rendered view of DESIGN.md
    if (req.method === 'GET' && (url.pathname === '/design' || url.pathname === '/design.html')) {
      const fs = await import('fs');
      const path = await import('path');
      const designPath = path.join(process.cwd(), 'DESIGN.md');
      const markdown = fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf-8') : '# DESIGN.md not found';
      
      const designHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DESIGN.md - Two-Way Sync Engine</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-dark.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    body { background-color: #0d1117; margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .top-nav { max-width: 980px; margin: 0 auto 16px auto; display: flex; justify-content: space-between; align-items: center; }
    .top-nav a { color: #58a6ff; text-decoration: none; font-weight: 600; font-size: 14px; }
    .top-nav a:hover { text-decoration: underline; }
    .markdown-body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; background-color: #0d1117; border: 1px solid #30363d; border-radius: 8px; }
    @media (max-width: 767px) { .markdown-body { padding: 15px; } }
  </style>
</head>
<body>
  <div class="top-nav">
    <a href="/">← Back to Control Panel</a>
    <a href="/docs">Open Swagger UI →</a>
  </div>
  <article class="markdown-body" id="content">Loading...</article>
  <script>
    const md = ${JSON.stringify(markdown)};
    document.getElementById('content').innerHTML = marked.parse(md);
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(designHtml);
    }

    // 2. GET /api/docs/openapi.json -> Serve OpenAPI 3.0 Specification
    if (req.method === 'GET' && url.pathname === '/api/docs/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(getOpenApiSpec(), null, 2));
    }

    // 3. GET / -> Serve 1-Click Interactive Dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(getHtmlDashboard());
    }

    // JSON API Endpoints
    res.setHeader('Content-Type', 'application/json');

    // 4. GET /api/contact/:id -> View contact state & audit log
    if (req.method === 'GET' && url.pathname.startsWith('/api/contact/')) {
      const id = url.pathname.replace('/api/contact/', '');
      const contact = db.getContact(id);
      const auditLogs = db.getAuditLogs(id);
      res.writeHead(contact ? 200 : 404);
      return res.end(JSON.stringify({ contact, auditLogs }, null, 2));
    }

    // 5. POST /api/webhooks/salesforce -> Webhook endpoint
    if (url.pathname === '/api/webhooks/salesforce') {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end(
          JSON.stringify(
            {
              error: 'Method Not Allowed: /api/webhooks/salesforce requires POST.',
              swaggerUi: 'Visit http://localhost:3000/docs to test with Swagger UI.',
            },
            null,
            2
          )
        );
      }
      const payload = await parseJson(req);
      const result = inboundHandler.processWebhook(payload);
      res.writeHead(200);
      return res.end(JSON.stringify(result, null, 2));
    }

    // 6. POST /api/portal/edit -> Portal user edit endpoint
    if (url.pathname === '/api/portal/edit') {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end(
          JSON.stringify(
            {
              error: 'Method Not Allowed: /api/portal/edit requires POST.',
              swaggerUi: 'Visit http://localhost:3000/docs to test with Swagger UI.',
            },
            null,
            2
          )
        );
      }
      const payload = await parseJson(req);
      const result = portalApi.editContact(payload);
      res.writeHead(200);
      return res.end(JSON.stringify(result, null, 2));
    }

    // 7. POST /api/sync/drain -> Trigger sync worker to drain outbox to Salesforce
    if (req.method === 'POST' && url.pathname === '/api/sync/drain') {
      const stats = await syncWorker.drainQueue();
      res.writeHead(200);
      return res.end(JSON.stringify({ message: 'Outbox drained', stats }, null, 2));
    }

    // 8. POST /api/salesforce/outage -> Toggle 6-hour Salesforce outage on/off
    if (req.method === 'POST' && url.pathname === '/api/salesforce/outage') {
      const body = await parseJson(req);
      const enable = body.outage ?? !sfdc.getIsOutage();
      sfdc.setOutage(enable);
      res.writeHead(200);
      return res.end(JSON.stringify({ salesforceOutage: sfdc.getIsOutage() }, null, 2));
    }

    // 9. GET /api/status -> View pending outbox queue and CRM status
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200);
      return res.end(
        JSON.stringify(
          {
            salesforceOutage: sfdc.getIsOutage(),
            pendingOutboxCount: db.getPendingOutboxEvents(true).length,
            pendingOutboxEvents: db.getPendingOutboxEvents(true),
          },
          null,
          2
        )
      );
    }

    // 10. POST /api/reset -> Reset demo database & CRM state to clean baseline
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      db.clearAll();
      sfdc.setOutage(false);
      sfdc.resetApiCallCount();
      seedDefaultContact();
      res.writeHead(200);
      return res.end(
        JSON.stringify(
          {
            message: 'Demo state reset to clean baseline.',
            contactId: '0031A00000Abc',
          },
          null,
          2
        )
      );
    }

    res.writeHead(404);
    res.end(
      JSON.stringify(
        {
          error: 'Endpoint not found',
          swaggerUi: 'http://localhost:3000/docs',
          controlPanel: 'http://localhost:3000/',
        },
        null,
        2
      )
    );
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }, null, 2));
  }
});

server.listen(PORT, () => {
  console.log(`\n========================================================================`);
  console.log(`  📖 Swagger UI (OpenAPI 3.0):       http://localhost:${PORT}/docs`);
  console.log(`  🎮 Interactive Control Panel:      http://localhost:${PORT}/`);
  console.log(`========================================================================\n`);
});
