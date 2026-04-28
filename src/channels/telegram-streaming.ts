import { MessageStreamManager, type MessageStreamManagerOpts } from "./message-streaming.js";

export type TelegramStreamManagerOpts = MessageStreamManagerOpts<number>;

export class TelegramStreamManager extends MessageStreamManager<number> {}
