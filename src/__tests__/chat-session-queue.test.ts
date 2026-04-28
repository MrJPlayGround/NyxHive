import { describe, expect, test } from "bun:test";
import { ChatSessionQueue } from "../server/ws/chat-session-queue.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("ChatSessionQueue", () => {
	test("serializes tasks for the same session key", async () => {
		const queue = new ChatSessionQueue();
		const gate = deferred();
		const order: string[] = [];

		const first = queue.run("thread:t-1", async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
			return "first";
		});
		const second = queue.run("thread:t-1", async () => {
			order.push("second:start");
			order.push("second:end");
			return "second";
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);

		gate.resolve();
		expect(await first).toBe("first");
		expect(await second).toBe("second");
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	test("allows different session keys to progress independently", async () => {
		const queue = new ChatSessionQueue();
		const gate = deferred();
		const order: string[] = [];

		const first = queue.run("thread:t-1", async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
		});
		const second = queue.run("thread:t-2", async () => {
			order.push("second:start");
			order.push("second:end");
		});

		await Promise.resolve();
		await Promise.resolve();
		await second;
		expect(order).toEqual(["first:start", "second:start", "second:end"]);

		gate.resolve();
		await first;
		expect(order).toEqual(["first:start", "second:start", "second:end", "first:end"]);
	});
});
