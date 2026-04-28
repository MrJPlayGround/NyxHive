import { create } from "zustand";
import { gateway } from "../lib/ws";

export interface SearchResult {
	content: string;
	source: string;
	score: number;
	timestamp?: number;
}

export interface KnowledgeEntry {
	id?: number;
	title: string;
	section: string | null;
	content: string;
	category: string | null;
	source_path: string;
}

export interface KnowledgeStats {
	totalChunks: number;
	totalFiles: number;
	categories: Record<string, number>;
	tiers?: Record<string, number>;
	compiledPages?: number;
}

export interface KnowledgeDigestPage {
	id: number;
	source_key: string;
	source_path: string;
	title: string;
	category: string | null;
	summary: string;
	content: string;
	source_hash: string;
	chunk_count: number;
	stale: number;
	created_at: number;
	updated_at: number;
	last_accessed_at: number | null;
	access_count: number;
}

export interface KnowledgeDigestAuditResult {
	checked: number;
	markedStale: number;
	restoredFresh: number;
	missingSources: number;
}

interface KnowledgeState {
	query: string;
	digestQuery: string;
	memoryResults: SearchResult[];
	knowledgeResults: SearchResult[];
	searching: boolean;
	digestsLoading: boolean;
	digestActionSourcePath: string | null;
	digestAudit: KnowledgeDigestAuditResult | null;
	recentEntries: KnowledgeEntry[];
	digests: KnowledgeDigestPage[];
	stats: KnowledgeStats | null;
	loaded: boolean;

	setQuery: (query: string) => void;
	setDigestQuery: (query: string) => void;
	search: (limit?: number) => Promise<void>;
	loadInitial: () => Promise<void>;
	loadDigests: (limit?: number) => Promise<void>;
	compileDigest: (sourcePath: string) => Promise<void>;
	setDigestStale: (id: number, stale: boolean) => Promise<void>;
	auditDigests: () => Promise<void>;
	reset: () => void;
}

export const useKnowledgeStore = create<KnowledgeState>()((set, get) => ({
	query: "",
	digestQuery: "",
	memoryResults: [],
	knowledgeResults: [],
	searching: false,
	digestsLoading: false,
	digestActionSourcePath: null,
	digestAudit: null,
	recentEntries: [],
	digests: [],
	stats: null,
	loaded: false,

	setQuery: (query: string) => set({ query }),
	setDigestQuery: (digestQuery: string) => set({ digestQuery }),

	reset: () => set({ loaded: false, stats: null, recentEntries: [], memoryResults: [], knowledgeResults: [], digests: [], digestAudit: null }),

	loadInitial: async () => {
		if (get().loaded) return;
		try {
			const [statsRes, recentRes, digestRes] = await Promise.allSettled([
				gateway.request<{ stats: KnowledgeStats | null }>("knowledge.stats", {}),
				gateway.request<{ entries: KnowledgeEntry[] }>("knowledge.recent", { limit: 20 }),
				gateway.request<{ pages: KnowledgeDigestPage[] }>("knowledge.digests.list", { limit: 25 }),
			]);
			const gotStats = statsRes.status === "fulfilled";
			const gotRecent = recentRes.status === "fulfilled";
			const gotDigests = digestRes.status === "fulfilled";
			set({
				stats: gotStats ? statsRes.value.stats : null,
				recentEntries: gotRecent ? (recentRes.value.entries ?? []) : [],
				digests: gotDigests ? (digestRes.value.pages ?? []) : [],
				loaded: gotStats || gotRecent || gotDigests,
			});
		} catch {
			// Don't set loaded on total failure — allow retry
		}
	},

	loadDigests: async (limit = 50) => {
		const { digestQuery } = get();
		set({ digestsLoading: true });
		try {
			const result = await gateway.request<{ pages: KnowledgeDigestPage[] }>("knowledge.digests.list", {
				query: digestQuery.trim() || undefined,
				limit,
			});
			set({ digests: result.pages ?? [], digestsLoading: false });
		} catch {
			set({ digestsLoading: false });
		}
	},

	compileDigest: async (sourcePath: string) => {
		const trimmed = sourcePath.trim();
		if (!trimmed) return;
		set({ digestActionSourcePath: trimmed });
		try {
			const result = await gateway.request<{ page: KnowledgeDigestPage }>("knowledge.digests.compile", { sourcePath: trimmed });
			set((state) => ({
				digests: [result.page, ...state.digests.filter((page) => page.id !== result.page.id)],
				stats: state.stats
					? { ...state.stats, compiledPages: Math.max(state.stats.compiledPages ?? 0, [result.page, ...state.digests.filter((page) => page.id !== result.page.id)].length) }
					: state.stats,
				digestActionSourcePath: null,
			}));
		} catch {
			set({ digestActionSourcePath: null });
		}
	},

	setDigestStale: async (id: number, stale: boolean) => {
		try {
			const result = await gateway.request<{ page: KnowledgeDigestPage }>("knowledge.digests.stale", { id, stale });
			set((state) => ({
				digests: state.digests.map((page) => page.id === id ? result.page : page),
			}));
		} catch {
			// Keep current UI state; next refresh will reconcile.
		}
	},

	auditDigests: async () => {
		set({ digestsLoading: true });
		try {
			const result = await gateway.request<{ audit: KnowledgeDigestAuditResult }>("knowledge.digests.audit", {});
			const pages = await gateway.request<{ pages: KnowledgeDigestPage[] }>("knowledge.digests.list", {
				query: get().digestQuery.trim() || undefined,
				limit: 50,
			});
			set({ digestAudit: result.audit, digests: pages.pages ?? [], digestsLoading: false });
		} catch {
			set({ digestsLoading: false });
		}
	},

	search: async (limit = 25) => {
		const { query } = get();
		if (!query.trim()) return;

		set({ searching: true });
		try {
			const [memoryRes, knowledgeRes] = await Promise.allSettled([
				gateway.request<{ results: SearchResult[] }>("memory.search", {
					query,
					limit,
				}),
				gateway.request<{ results: SearchResult[] }>("knowledge.search", {
					query,
					limit,
				}),
			]);

			set({
				memoryResults:
					memoryRes.status === "fulfilled"
						? (memoryRes.value.results ?? [])
						: [],
				knowledgeResults:
					knowledgeRes.status === "fulfilled"
						? (knowledgeRes.value.results ?? [])
						: [],
				searching: false,
			});
		} catch {
			set({ searching: false });
		}
	},
}));
