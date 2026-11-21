export type ObjectType = 'Customer' | 'Contact';

export interface Customer {
  id: string;
  salesforceId: string;
  name: string;
  status: 'Active' | 'Prospect' | 'Churned';
  owner: string;
  // Field-level modification timestamps (ISO strings)
  nameUpdatedAt: string;
  statusUpdatedAt: string;
  ownerUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  salesforceId: string;
  customerId: string;
  fullName: string;
  phone?: string;
  email?: string;
  city?: string;
  owner: string;
  // Field-level modification timestamps (ISO strings)
  fullNameUpdatedAt: string;
  phoneUpdatedAt: string;
  emailUpdatedAt: string;
  cityUpdatedAt: string;
  ownerUpdatedAt: string;
  customerIdUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InboundWebhookEvent {
  eventId: string;
  recordId: string;
  objectType: ObjectType;
  occurredAt: string;
  changedBy: string;
  changedFields: Record<string, string>;
}

export interface OutboxEvent {
  id: number;
  recordId: string;
  objectType: ObjectType;
  operation: 'CREATE' | 'UPDATE';
  payload: Record<string, string>;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  attempts: number;
  nextRetryAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: number;
  recordId: string;
  objectType: ObjectType;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  occurredAt: string;
  recordedAt: string;
  source: 'SALESFORCE_WEBHOOK' | 'PORTAL_USER';
  status: 'APPLIED' | 'SUPERSEDED_OUT_OF_ORDER' | 'ECHO_SUPPRESSED';
}

export interface PortalEditRequest {
  recordId: string;
  objectType: ObjectType;
  editedBy: string;
  changedFields: Record<string, string>;
}

export const SF_INTEGRATION_USER = 'tequity.sync.service@client.example';
