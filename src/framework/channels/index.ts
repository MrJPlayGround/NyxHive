export { iosChannel } from "./ios.js";
export { webhookChannel } from "./webhook.js";
export { telegramChannel } from "./telegram.js";
export { discordChannel } from "./discord.js";
export { slackChannel } from "./slack.js";
export { imessageChannel } from "./imessage.js";

import type { ChannelFactory } from "../types.js";
import { iosChannel } from "./ios.js";
import { webhookChannel } from "./webhook.js";
import { telegramChannel } from "./telegram.js";
import { discordChannel } from "./discord.js";
import { slackChannel } from "./slack.js";
import { imessageChannel } from "./imessage.js";

export function allBuiltinChannels(): ChannelFactory[] {
  return [iosChannel, webhookChannel, telegramChannel, discordChannel, slackChannel, imessageChannel];
}
