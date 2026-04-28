export class ChatSessionQueue {
	private queues = new Map<string, Promise<void>>();

	isBusy(sessionKey: string): boolean {
		return this.queues.has(sessionKey);
	}

	run<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
		const prior = this.queues.get(sessionKey) ?? Promise.resolve();
		const next = prior.catch(() => {}).then(task);
		const settled = next.then(() => undefined, () => undefined).finally(() => {
			if (this.queues.get(sessionKey) === settled) {
				this.queues.delete(sessionKey);
			}
		});
		this.queues.set(sessionKey, settled);
		return next;
	}
}

export function getChatSessionKey(threadId: string | null | undefined, deviceId: string): string {
	return threadId ? `thread:${threadId}` : `device:${deviceId}`;
}
