import { create } from "zustand";
import { gateway } from "../lib/ws";
import { toast_error, toast_success } from "../components/ui/toast";

export interface Proposal {
	id: string;
	title: string;
	description: string;
	category: string;
	priority: string;
	effort: string;
	status: string;
	filesAffected: string[];
	reviewResult?: string;
	reviewedBy?: string;
	reviewedAt?: number;
	executionResult?: string;
	executedBy?: string;
	rejectionReason?: string;
	approvedBy?: string;
	approvedAt?: number;
	reviewVerdict?: string;
	reviewQueuePosition?: number;
	prUrl?: string;
	prMergeable?: string;
	createdAt: number;
	updatedAt: number;
}

export const QUEUED_REVIEW_STATUS = "queued_review";

const optimisticStatusFallbacks: Record<string, string[]> = {
	[QUEUED_REVIEW_STATUS]: ["proposed", "reviewed"],
	reviewing: ["proposed"],
	approved: ["proposed", "reviewed", "reviewing"],
	rejected: ["proposed", "reviewed", "reviewing", "approved"],
	executing: ["approved"],
};

// Some old proposals have timestamps in seconds instead of milliseconds
function toMs(ts: number): number {
	return ts < 1e12 ? ts * 1000 : ts;
}

// API returns snake_case from SQLite — map to camelCase
function mapProposal(raw: any): Proposal {
	return {
		id: raw.proposal_id ?? raw.id,
		title: raw.title,
		description: raw.description,
		category: raw.category,
		priority: raw.priority,
		effort: raw.effort,
		status: raw.status,
		filesAffected: raw.files_affected ? (typeof raw.files_affected === 'string' ? JSON.parse(raw.files_affected) : raw.files_affected) : [],
		reviewResult: raw.review_result ?? raw.reviewResult ?? undefined,
		reviewedBy: raw.reviewed_by ?? raw.reviewedBy ?? undefined,
		reviewedAt: raw.reviewed_at ? toMs(raw.reviewed_at) : undefined,
		executionResult: raw.execution_result ?? raw.executionResult ?? undefined,
		executedBy: raw.executed_by ?? raw.executedBy ?? undefined,
		rejectionReason: raw.rejection_reason ?? raw.rejectionReason ?? undefined,
		approvedBy: raw.approved_by ?? raw.approvedBy ?? undefined,
		approvedAt: raw.approved_at ? toMs(raw.approved_at) : undefined,
		reviewVerdict: raw.verdict ?? raw.reviewVerdict,
		reviewQueuePosition: undefined,
		prUrl: raw.pr_url ?? raw.prUrl,
		prMergeable: raw.pr_mergeable ?? raw.prMergeable ?? undefined,
		createdAt: toMs(raw.created_at ?? raw.createdAt),
		updatedAt: toMs(raw.updated_at ?? raw.updatedAt),
	};
}

function mergeFetchedProposal(existing: Proposal | undefined, incoming: Proposal): Proposal {
	if (!existing) {
		return incoming;
	}
	const fallbackStatuses = optimisticStatusFallbacks[existing.status];
	if (fallbackStatuses?.includes(incoming.status) && incoming.updatedAt <= existing.updatedAt) {
		return {
			...incoming,
			status: existing.status,
			reviewQueuePosition:
				existing.status === QUEUED_REVIEW_STATUS ? existing.reviewQueuePosition : undefined,
		};
	}
	return incoming;
}

function getQueuedReviewUpdates(position?: number): Partial<Proposal> {
	if (typeof position === "number" && position > 0) {
		return { status: QUEUED_REVIEW_STATUS, reviewQueuePosition: position };
	}
	return { status: "reviewing", reviewQueuePosition: undefined };
}

function getRequestErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	if (error && typeof error === "object") {
		const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
		if (message) {
			return message;
		}
		const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
		if (code) {
			return code;
		}
	}
	return "Unknown error";
}

interface ProposalsState {
	proposals: Proposal[];
	loading: boolean;
	statusFilter: string;

	selectedProposalId: string | null;
	selectProposal: (id: string | null) => void;

	fetchProposals: () => Promise<void>;
	setStatusFilter: (status: string) => void;
	approve: (id: string, notes?: string) => Promise<void>;
	execute: (id: string) => Promise<void>;
	executeAll: (bundlePr: boolean) => Promise<void>;
	reject: (id: string, notes?: string) => Promise<void>;
	startReview: (id: string, model?: string) => Promise<void>;
	reviewAll: () => Promise<void>;
	createPr: (id: string) => Promise<void>;
	mergePr: (id: string) => Promise<void>;
	retryProposal: (id: string) => Promise<void>;
	requeueProposal: (id: string) => Promise<void>;
	deleteProposal: (id: string) => Promise<void>;
	clearTerminal: () => Promise<number>;
	updateProposal: (id: string, updates: Partial<Proposal>) => void;
}

export const useProposalsStore = create<ProposalsState>()((set, get) => ({
	proposals: [],
	loading: true,
	statusFilter: "",
	selectedProposalId: null,
	selectProposal: (id) => set({ selectedProposalId: id }),

	fetchProposals: async () => {
		set({ loading: true });
		try {
			const { statusFilter } = get();
			const result = await gateway.request<{ proposals: any[] }>(
				"proposals.list",
				{ status: statusFilter || undefined },
			);
			const existingById = new Map(get().proposals.map((proposal) => [proposal.id, proposal]));
			set({
				proposals: (result.proposals ?? [])
					.map(mapProposal)
					.map((proposal) => mergeFetchedProposal(existingById.get(proposal.id), proposal)),
				loading: false,
			});
		} catch {
			set({ loading: false });
		}
	},

	setStatusFilter: (status) => {
		set({ statusFilter: status });
		get().fetchProposals();
	},

	approve: async (id, notes) => {
		get().updateProposal(id, { status: "approved" });
		try {
			await gateway.request("proposals.approve", { proposalId: id, notes });
			toast_success("Proposal approved");
			get().fetchProposals();
		} catch (error) {
			get().fetchProposals();
			toast_error("Failed to approve", getRequestErrorMessage(error));
			throw error;
		}
	},

	execute: async (id) => {
		get().updateProposal(id, { status: "executing" });
		try {
			await gateway.request("proposals.execute", { proposalId: id });
			toast_success("Execution triggered");
			get().fetchProposals();
		} catch (error) {
			get().fetchProposals();
			toast_error("Failed to start execution", getRequestErrorMessage(error));
			throw error;
		}
	},

	executeAll: async (bundlePr) => {
		// Optimistically mark all approved as executing
		const approved = get().proposals.filter((p) => p.status === "approved");
		for (const p of approved) {
			get().updateProposal(p.id, { status: "executing" });
		}
		try {
			const result = await gateway.request<{ triggered: number; bundlePr: boolean }>(
				"proposals.executeAll",
				{ bundlePr },
			);
			toast_success(
				`Triggered ${result.triggered} proposal${result.triggered === 1 ? "" : "s"}`,
				bundlePr ? "Will be bundled into 1 PR" : undefined,
			);
			get().fetchProposals();
		} catch (error) {
			get().fetchProposals();
			toast_error("Failed to trigger all", getRequestErrorMessage(error));
			throw error;
		}
	},

	reject: async (id, notes) => {
		get().updateProposal(id, { status: "rejected", rejectionReason: notes ?? "Rejected via Gateway" });
		try {
			await gateway.request("proposals.reject", { proposalId: id, notes });
			toast_success("Proposal rejected");
			get().fetchProposals();
		} catch (error) {
			get().fetchProposals();
			toast_error("Failed to reject", getRequestErrorMessage(error));
			throw error;
		}
	},

	startReview: async (id, model) => {
		try {
			const result = await gateway.request<{ status?: string; position?: number }>(
				"proposals.startReview",
				{ proposalId: id, ...(model ? { model } : {}) },
			);
			const position = result.position;
			get().updateProposal(id, getQueuedReviewUpdates(position));
			if (typeof position === "number" && position > 0) {
				toast_success(
					"Queued for review",
					`Waiting for ${position} earlier review${position === 1 ? "" : "s"}.`,
				);
			} else {
				toast_success(model ? `Review started (${model})` : "Review started");
			}
			get().fetchProposals();
		} catch (error) {
			get().fetchProposals();
			toast_error("Failed to start review", getRequestErrorMessage(error));
			throw error;
		}
	},

	createPr: async (id) => {
		try {
			const result = await gateway.request<{ proposal?: any; pr_url?: string }>("proposals.createPr", { proposalId: id });
			if (result.proposal) {
				get().updateProposal(id, mapProposal(result.proposal));
			}
			toast_success(result.pr_url ? "PR ready" : "PR already exists");
			get().fetchProposals();
		} catch (error) {
			toast_error("Failed to create PR", getRequestErrorMessage(error));
			throw error;
		}
	},

	mergePr: async (id) => {
		try {
			const result = await gateway.request<{ proposal?: any; already_merged?: boolean }>("proposals.merge", { proposalId: id });
			if (result.proposal) {
				get().updateProposal(id, mapProposal(result.proposal));
			}
			toast_success(result.already_merged ? "PR was already merged" : "PR merged");
			get().fetchProposals();
		} catch (error) {
			toast_error("Failed to merge PR", getRequestErrorMessage(error));
			throw error;
		}
	},

	retryProposal: async (id) => {
		try {
			const result = await gateway.request<{ proposal?: any }>("proposals.retry", { proposalId: id });
			if (result.proposal) {
				get().updateProposal(id, mapProposal(result.proposal));
			}
			toast_success("PR closed, queued for re-execution");
			get().fetchProposals();
		} catch (error) {
			toast_error("Failed to retry", getRequestErrorMessage(error));
			throw error;
		}
	},

	requeueProposal: async (id) => {
		try {
			const result = await gateway.request<{ proposal?: any }>("proposals.requeue", { proposalId: id });
			if (result.proposal) {
				get().updateProposal(id, mapProposal(result.proposal));
			}
			toast_success("PR closed, sent back to review");
			get().fetchProposals();
		} catch (error) {
			toast_error("Failed to requeue", getRequestErrorMessage(error));
			throw error;
		}
	},

	reviewAll: async () => {
		const proposed = get().proposals.filter((p) => p.status === "proposed");
		let started = 0;
		let queued = 0;
		for (const proposal of proposed) {
			const result = await gateway.request<{ status?: string; position?: number }>(
				"proposals.startReview",
				{ proposalId: proposal.id },
			);
			const position = result.position;
			get().updateProposal(proposal.id, getQueuedReviewUpdates(position));
			if (typeof position === "number" && position > 0) queued += 1;
			else started += 1;
		}
		if (proposed.length > 0) {
			toast_success(
				`Sent ${proposed.length} proposal${proposed.length === 1 ? "" : "s"} to review`,
				queued > 0 ? `${started} started, ${queued} queued.` : undefined,
			);
		}
		get().fetchProposals();
	},

	deleteProposal: async (id) => {
		await gateway.request("proposals.delete", { proposalId: id });
		toast_success("Proposal deleted");
		set((state) => ({
			proposals: state.proposals.filter((p) => p.id !== id),
		}));
	},

	clearTerminal: async () => {
		const result = await gateway.request<{ deleted: number }>(
			"proposals.deleteTerminal",
			{},
		);
		toast_success(`Cleared ${result.deleted} proposals`);
		get().fetchProposals();
		return result.deleted;
	},

	updateProposal: (id, updates) => {
		set((state) => ({
			proposals: state.proposals.map((p) => {
				if (p.id !== id) {
					return p;
				}
				const nextProposal = { ...p, ...updates };
				if (nextProposal.status !== QUEUED_REVIEW_STATUS) {
					nextProposal.reviewQueuePosition = undefined;
				}
				return nextProposal;
			}),
		}));
	},
}));
