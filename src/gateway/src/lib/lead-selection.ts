const LEAD_DEFAULT_AGENT_KEYS = new Set(["nyx", "vortex", "onyx", "strider", "aether", "morph"]);

export function shouldSyncGatewayLeadAgent(opts: {
	authenticated: boolean;
	threadId?: string | null;
	activeAgent?: string | null;
	leadAgent?: string | null;
}): boolean {
	const { authenticated, threadId, activeAgent, leadAgent } = opts;
	if (!authenticated || !leadAgent || threadId) return false;
	if (!activeAgent) return true;

	const normalizedActive = activeAgent.trim().toLowerCase();
	const normalizedLead = leadAgent.trim().toLowerCase();
	if (!normalizedActive || normalizedActive === normalizedLead) return false;
	return LEAD_DEFAULT_AGENT_KEYS.has(normalizedActive);
}
