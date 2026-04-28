export interface WorkspaceLoadPlanInput {
	authenticated: boolean;
	hasFleetChat: boolean;
	threadId: string | null;
	messageCount: number;
	hasOnlyTransientAssistantMessages?: boolean;
}

export interface WorkspaceLoadPlan {
	loadRequests: boolean;
	fetchThreads: boolean;
	loadModelInfo: boolean;
	loadHistory: boolean;
}

export function getWorkspaceLoadPlan(input: WorkspaceLoadPlanInput): WorkspaceLoadPlan {
	if (!input.authenticated || !input.hasFleetChat) {
		return {
			loadRequests: false,
			fetchThreads: false,
			loadModelInfo: false,
			loadHistory: false,
		};
	}

	return {
		loadRequests: true,
		fetchThreads: true,
		loadModelInfo: true,
		loadHistory: Boolean(input.threadId)
			&& (input.messageCount === 0 || input.hasOnlyTransientAssistantMessages === true),
	};
}
