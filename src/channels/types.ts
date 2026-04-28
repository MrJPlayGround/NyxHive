export interface ChannelStats {
  messagesReceived: number;
  messagesSent: number;
  errors: number;
}

export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  getStats(): ChannelStats;
  /** Send an unsolicited outbound message (for alerts). Optional per channel. */
  sendOutbound?(recipientId: string, message: string, agent?: string, replyToId?: string): Promise<void>;
  /** Send a rich proposal notification with approve/reject buttons. Optional per channel. */
  sendProposalNotification?(recipientId: string, proposal: import("../proposals/store.js").Proposal): Promise<void>;
  editMessage?(channel: string, ts: string, text: string): Promise<{ ok: boolean; error?: string }>;
  deleteMessage?(channel: string, ts: string): Promise<{ ok: boolean; error?: string }>;
}
