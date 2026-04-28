export interface ChannelEvent {
  type: string;
  channel_id: string;
  channel_name?: string;
}

export interface MemberEvent {
  type: string;
  user_id: string;
  channel_id: string;
}

export function formatChannelEvent(type: string, data: any): ChannelEvent {
  return {
    type,
    channel_id: data.id ?? data.channel?.id ?? data.channel,
    channel_name: data.name ?? data.channel?.name,
  };
}

export function formatMemberEvent(type: string, data: any): MemberEvent {
  return {
    type,
    user_id: data.user,
    channel_id: data.channel,
  };
}

export interface MessageEvent {
  type: "message_changed" | "message_deleted";
  channel: string;
  user_id?: string;
  previous_text?: string;
  new_text?: string;
  ts?: string;
}

export function formatMessageEvent(type: "message_changed" | "message_deleted", data: any): MessageEvent {
  return {
    type,
    channel: data.channel,
    user_id: data.previous_message?.user ?? data.message?.user,
    previous_text: data.previous_message?.text,
    new_text: type === "message_changed" ? data.message?.text : undefined,
    ts: data.previous_message?.ts,
  };
}
