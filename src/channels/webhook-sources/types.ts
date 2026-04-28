export interface WebhookSourceConfig {
  secret_env: string;
  events: string[];
  agent?: string;
  repos?: string[];
}

export interface WebhookEvent {
  source: string;
  type: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface WebhookAction {
  channel: string;
  sender: string;
  senderId: string;
  message: string;
  agent?: string;
}

export interface WebhookSource {
  name: string;
  verifySignature(body: string, signature: string, secret: string): boolean;
  parseEvent(headers: Record<string, string>, body: string): WebhookEvent | null;
  mapToAction(event: WebhookEvent, config: WebhookSourceConfig): WebhookAction | null;
}
