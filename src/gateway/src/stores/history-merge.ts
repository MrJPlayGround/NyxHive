import type { ChatMessage } from "./chat";

const USER_MESSAGE_MARKER = "\n\n[User Message]\n";

type KeepLocalMessage = (
	message: ChatMessage,
	streamingMessageId: string | null,
) => boolean;

function comparableUserContent(content: string): string {
	const markerIndex = content.lastIndexOf(USER_MESSAGE_MARKER);
	return markerIndex >= 0
		? content.slice(markerIndex + USER_MESSAGE_MARKER.length)
		: content;
}

function userMessageKey(message: ChatMessage): string {
	return comparableUserContent(message.content);
}

function decrementCount(counts: Map<string, number>, key: string): void {
	const count = counts.get(key) ?? 0;
	if (count <= 1) {
		counts.delete(key);
		return;
	}
	counts.set(key, count - 1);
}

function defaultKeepLocalMessage(
	message: ChatMessage,
	streamingMessageId: string | null,
): boolean {
	return message.role === "user" || message.id === streamingMessageId;
}

export function mergeHistoryMessages(
	serverMessages: ChatMessage[],
	localMessages: ChatMessage[],
	streamingMessageId: string | null,
	keepLocalMessage: KeepLocalMessage = defaultKeepLocalMessage,
): ChatMessage[] {
	const serverIds = new Set(serverMessages.map((message) => message.id));
	const unmatchedServerUsers = new Map<string, number>();

	for (const message of serverMessages) {
		if (message.role !== "user") continue;
		const key = userMessageKey(message);
		unmatchedServerUsers.set(key, (unmatchedServerUsers.get(key) ?? 0) + 1);
	}

	for (const message of localMessages) {
		if (message.role === "user" && serverIds.has(message.id)) {
			decrementCount(unmatchedServerUsers, userMessageKey(message));
		}
	}

	const localOnly = localMessages.filter((message) => {
		if (serverIds.has(message.id)) return false;
		if (!keepLocalMessage(message, streamingMessageId)) return false;
		if (message.role !== "user") return true;

		const key = userMessageKey(message);
		const matchingServerCount = unmatchedServerUsers.get(key) ?? 0;
		if (matchingServerCount > 0) {
			decrementCount(unmatchedServerUsers, key);
			return false;
		}
		return true;
	});

	return [...serverMessages, ...localOnly];
}
