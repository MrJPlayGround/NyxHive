import { create } from "zustand";
import { toast_success } from "../components/ui/toast";
import { gateway } from "../lib/ws";

export interface Thread {
	id: string;
	title: string;
	agent: string;
	project: string;
	status: string;
	category: string | null;
	messageCount: number;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	createdAt: number;
	updatedAt: number;
}

export interface ThreadDetail extends Thread {
	messages: Array<{
		role: string;
		content: string;
		agent?: string;
		timestamp: number;
	}>;
	delegationChain?: string[];
	gitBranch?: string;
	prUrl?: string;
}

interface ThreadsState {
	threads: Thread[];
	total: number | null;
	loading: boolean;
	filters: {
		agent: string;
		project: string;
		status: string;
	};

	fetchThreads: (offset?: number, limit?: number) => Promise<{ items: Thread[]; total?: number }>;
	setFilter: (key: keyof ThreadsState["filters"], value: string) => void;
	getThread: (id: string) => Promise<ThreadDetail | null>;
	renameThread: (id: string, title: string) => Promise<void>;
	deleteThread: (id: string) => Promise<void>;
	archiveThread: (id: string) => Promise<void>;
	setCategory: (id: string, category: string | null) => Promise<void>;
	getCategories: () => string[];
}

export const useThreadsStore = create<ThreadsState>()((set, get) => ({
	threads: [],
	total: null,
	loading: false,
	filters: { agent: "", project: "", status: "" },

	fetchThreads: async (offset = 0, limit = 50) => {
		set({ loading: true });
		try {
			const { filters } = get();
			const result = await gateway.request<{ threads: Thread[]; total?: number }>(
				"threads.list",
				{
					agent: filters.agent || undefined,
					projectId: filters.project || undefined,
					status: filters.status || undefined,
					limit,
					offset,
				},
			);
			const threads = result.threads ?? [];
			set({ threads, total: result.total ?? null, loading: false });
			return { items: threads, total: result.total };
		} catch {
			set({ loading: false });
			return { items: [] };
		}
	},

	setFilter: (key, value) => {
		set((state) => ({
			filters: { ...state.filters, [key]: value },
		}));
	},

	getThread: async (id) => {
		try {
			const result = await gateway.request<ThreadDetail>("threads.get", { id });
			return result;
		} catch {
			return null;
		}
	},

	renameThread: async (id, title) => {
		await gateway.request("threads.rename", { id, title });
		toast_success("Thread renamed");
		set((state) => ({
			threads: state.threads.map((t) =>
				t.id === id ? { ...t, title } : t,
			),
		}));
	},

	deleteThread: async (id) => {
		await gateway.request("threads.delete", { id });
		toast_success("Thread deleted");
		set((state) => ({
			threads: state.threads.filter((t) => t.id !== id),
		}));
	},

	archiveThread: async (id) => {
		await gateway.request("threads.archive", { id });
		toast_success("Thread archived");
		set((state) => ({
			threads: state.threads.filter((t) => t.id !== id),
		}));
	},

	setCategory: async (id, category) => {
		await gateway.request("threads.setCategory", { id, category });
		set((state) => ({
			threads: state.threads.map((t) =>
				t.id === id ? { ...t, category } : t,
			),
		}));
	},

	getCategories: () => {
		const cats = new Set<string>();
		for (const t of get().threads) {
			if (t.category) cats.add(t.category);
		}
		return Array.from(cats).sort();
	},
}));
