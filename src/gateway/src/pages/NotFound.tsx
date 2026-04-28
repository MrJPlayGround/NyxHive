import { Link } from "react-router-dom";
import { Home } from "lucide-react";

export function NotFoundPage() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4">
			<p className="text-6xl font-bold text-zinc-700">404</p>
			<p className="text-sm text-zinc-500">Page not found</p>
			<Link
				to="/"
				className="flex items-center gap-2 rounded-md bg-[var(--nyx-accent-dim)] px-4 py-2 text-sm font-medium text-[var(--nyx-accent)] transition-colors hover:bg-[rgb(var(--nyx-accent-rgb)/0.15)]"
			>
				<Home className="h-4 w-4" />
				Back to Home
			</Link>
		</div>
	);
}
