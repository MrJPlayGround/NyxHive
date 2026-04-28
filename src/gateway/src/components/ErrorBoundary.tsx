import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
	children: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false, error: null };

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary]", error, info.componentStack);
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-4 p-8">
					<AlertTriangle className="h-10 w-10 text-red-400" />
					<h2 className="text-lg font-semibold text-zinc-200">Something went wrong</h2>
					<p className="max-w-md text-center text-sm text-zinc-500">
						{this.state.error?.message ?? "An unexpected error occurred"}
					</p>
					<button
						type="button"
						onClick={() => this.setState({ hasError: false, error: null })}
						className="flex items-center gap-2 rounded-md bg-[var(--nyx-accent-dim)] px-4 py-2 text-sm font-medium text-[var(--nyx-accent)] transition-colors hover:bg-[rgb(var(--nyx-accent-rgb)/0.15)]"
					>
						<RefreshCw className="h-4 w-4" />
						Try again
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
