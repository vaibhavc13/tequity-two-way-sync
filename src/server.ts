import * as http from 'http';
import { DurableDatabase } from './db/storage.js';
import { FakeSalesforceCRM } from './services/fake-salesforce.js';
import { InboundWebhookHandler } from './services/inbound-webhook-handler.js';
import { PortalAPIService } from './services/portal-api.js';
import { OutboundSyncWorker } from './services/outbound-sync-worker.js';
import { TokenBucketRateLimiter } from './services/rate-limiter.js';
import { SF_INTEGRATION_USER } from './types.js';

const PORT = 3000;
const db = new DurableDatabase('./.data_server');
const sfdc = new FakeSalesforceCRM();
const rateLimiter = new TokenBucketRateLimiter(20);
const inboundHandler = new InboundWebhookHandler(db);
const portalApi = new PortalAPIService(db);
const syncWorker = new OutboundSyncWorker(db, sfdc, rateLimiter);

// Seed default contact if missing
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
    h1 { color: #38bdf8; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 15px; }
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
    <h1>Two-Way Sync Interactive Control Panel</h1>
    <div class="subtitle">Simulate real-time Salesforce Webhooks, Portal Edits, Outages, and Outbox Drains with 1 click.</div>

    <div class="grid">
      <!-- Action Buttons Card -->
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
      </div>

      <!-- State & Response Card -->
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

    <!-- Audit History Table Card -->
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
      // 1. Fetch Contact & Audit
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

      // 2. Fetch Status
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
      // Re-send the exact same eventId
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
      // Send an event dated in the past
      handleAction('/api/webhooks/salesforce', 'POST', {
        eventId: 'evt_stale_' + Date.now(),
        recordId: recordId,
        objectType: 'Contact',
        occurredAt: '2026-11-01T10:00:00.000Z', // Old date!
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

    // Refresh immediately on load
    refreshData();
    setInterval(refreshData, 3000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  try {
    // 0. GET / -> Serve Interactive Visual Control Panel
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(getHtmlDashboard());
    }

    // JSON response helper
    res.setHeader('Content-Type', 'application/json');

    // 1. GET /api/contact/:id -> View contact state & audit log
    if (req.method === 'GET' && url.pathname.startsWith('/api/contact/')) {
      const id = url.pathname.replace('/api/contact/', '');
      const contact = db.getContact(id);
      const auditLogs = db.getAuditLogs(id);
      res.writeHead(contact ? 200 : 404);
      return res.end(JSON.stringify({ contact, auditLogs }, null, 2));
    }

    // 2. /api/webhooks/salesforce -> Webhook endpoint
    if (url.pathname === '/api/webhooks/salesforce') {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end(JSON.stringify({
          error: 'Method Not Allowed: /api/webhooks/salesforce requires a POST request with JSON body. Visit http://localhost:3000 in your browser to test with 1 click!'
        }, null, 2));
      }
      const payload = await parseJson(req);
      const result = inboundHandler.processWebhook(payload);
      res.writeHead(200);
      return res.end(JSON.stringify(result, null, 2));
    }

    // 3. /api/portal/edit -> Portal user edit endpoint
    if (url.pathname === '/api/portal/edit') {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end(JSON.stringify({
          error: 'Method Not Allowed: /api/portal/edit requires a POST request with JSON body. Visit http://localhost:3000 in your browser to test with 1 click!'
        }, null, 2));
      }
      const payload = await parseJson(req);
      const result = portalApi.editContact(payload);
      res.writeHead(200);
      return res.end(JSON.stringify(result, null, 2));
    }

    // 4. POST /api/sync/drain -> Trigger sync worker to drain outbox to Salesforce
    if (req.method === 'POST' && url.pathname === '/api/sync/drain') {
      const stats = await syncWorker.drainQueue();
      res.writeHead(200);
      return res.end(JSON.stringify({ message: 'Outbox drained', stats }, null, 2));
    }

    // 5. POST /api/salesforce/outage -> Toggle 6-hour Salesforce outage on/off
    if (req.method === 'POST' && url.pathname === '/api/salesforce/outage') {
      const body = await parseJson(req);
      const enable = body.outage ?? !sfdc.getIsOutage();
      sfdc.setOutage(enable);
      res.writeHead(200);
      return res.end(JSON.stringify({ salesforceOutage: sfdc.getIsOutage() }, null, 2));
    }

    // 6. GET /api/status -> View pending outbox queue and CRM status
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

    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Endpoint not found',
      hint: 'Visit http://localhost:3000/ in your web browser for the visual control panel.'
    }, null, 2));
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }, null, 2));
  }
});

server.listen(PORT, () => {
  console.log(`\n========================================================================`);
  console.log(`  Interactive Visual Control Panel: http://localhost:${PORT}/`);
  console.log(`========================================================================`);
  console.log(`Open http://localhost:${PORT}/ in your browser to test every rule visually!`);
});
