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

// Seed a default contact if not present
if (!db.getContact('0031A00000Abc')) {
  inboundHandler.processWebhook({
    eventId: 'evt_init',
    recordId: '0031A00000Abc',
    objectType: 'Contact',
    occurredAt: new Date().toISOString(),
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  res.setHeader('Content-Type', 'application/json');

  try {
    // 1. GET /api/contact/:id -> View contact state & audit log
    if (req.method === 'GET' && url.pathname.startsWith('/api/contact/')) {
      const id = url.pathname.replace('/api/contact/', '');
      const contact = db.getContact(id);
      const auditLogs = db.getAuditLogs(id);
      res.writeHead(contact ? 200 : 404);
      return res.end(JSON.stringify({ contact, auditLogs }, null, 2));
    }

    // 2. POST /api/webhooks/salesforce -> Simulate incoming Salesforce webhook
    if (req.method === 'POST' && url.pathname === '/api/webhooks/salesforce') {
      const payload = await parseJson(req);
      const result = inboundHandler.processWebhook(payload);
      res.writeHead(200);
      return res.end(JSON.stringify(result, null, 2));
    }

    // 3. POST /api/portal/edit -> Simulate portal user saving an edit
    if (req.method === 'POST' && url.pathname === '/api/portal/edit') {
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
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  } catch (err: any) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  Manual Testing HTTP Server Running on port ${PORT}!`);
  console.log(`======================================================`);
  console.log(`Endpoints available for manual testing:`);
  console.log(`  - GET  http://localhost:${PORT}/api/contact/0031A00000Abc`);
  console.log(`  - POST http://localhost:${PORT}/api/webhooks/salesforce`);
  console.log(`  - POST http://localhost:${PORT}/api/portal/edit`);
  console.log(`  - POST http://localhost:${PORT}/api/sync/drain`);
  console.log(`  - POST http://localhost:${PORT}/api/salesforce/outage`);
  console.log(`  - GET  http://localhost:${PORT}/api/status\n`);
});
