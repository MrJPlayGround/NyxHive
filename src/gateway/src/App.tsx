import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/Home";

import { NotFoundPage } from "./pages/NotFound";
import { ToastProvider } from "./components/ui/toast";
import { useDeviceNotifications } from "./hooks/useDeviceNotifications";
import { useErrorToasts } from "./hooks/useErrorToasts";
import { resolveWorkspaceOperationsUrl } from "./lib/workspace-redirect";
import { Loader2 } from "lucide-react";

function PageLoader() {
	return (
		<div className="flex items-center justify-center py-24">
			<Loader2 className="h-6 w-6 animate-spin text-[var(--nyx-accent)]" />
		</div>
	);
}

// Lazy-load pages that aren't on the critical path
const AgentsPage = lazy(() => import("./pages/Agents").then((m) => ({ default: m.AgentsPage })));
const ThreadsPage = lazy(() => import("./pages/Threads").then((m) => ({ default: m.ThreadsPage })));
const ThreadDetailPage = lazy(() => import("./pages/ThreadDetail").then((m) => ({ default: m.ThreadDetailPage })));
const WorkPage = lazy(() => import("./pages/Work").then((m) => ({ default: m.WorkPage })));
const KnowledgePage = lazy(() => import("./pages/Knowledge").then((m) => ({ default: m.KnowledgePage })));
const LogsPage = lazy(() => import("./pages/Logs").then((m) => ({ default: m.LogsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const TracesPage = lazy(() => import("./pages/Traces").then((m) => ({ default: m.TracesPage })));
const ModelsPage = lazy(() => import("./pages/Models").then((m) => ({ default: m.ModelsPage })));
const ActivityFeedPage = lazy(() => import("./pages/ActivityFeed").then((m) => ({ default: m.ActivityFeedPage })));
const TransactionPage = lazy(() => import("./pages/Transaction").then((m) => ({ default: m.TransactionPage })));
const ControlStationPage = lazy(() => import("./pages/ControlStation").then((m) => ({ default: m.ControlStationPage })));

function GlobalListeners() {
	useDeviceNotifications();
	useErrorToasts();
	return null;
}

function WorkspaceOperationsRedirectPage() {
	const target =
		typeof window === "undefined"
			? "http://127.0.0.1:3777/operations"
			: resolveWorkspaceOperationsUrl(window.location);

	useEffect(() => {
		if (typeof window !== "undefined" && window.location.href !== target) {
			window.location.replace(target);
		}
	}, [target]);

	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-sm uppercase tracking-[0.28em] text-zinc-500">Workspace Redirect</p>
			<h1 className="text-2xl font-semibold text-zinc-100">Operations lives in Nyx Workspace</h1>
			<p className="max-w-xl text-sm leading-6 text-zinc-400">
				The gateway does not host the Operations surface. Forwarding you to the workspace app now.
			</p>
			<a
				href={target}
				className="rounded-md bg-[var(--nyx-accent-dim)] px-4 py-2 text-sm font-medium text-[var(--nyx-accent)] transition-colors hover:bg-[rgb(var(--nyx-accent-rgb)/0.15)]"
			>
				Open Nyx Workspace Operations
			</a>
		</div>
	);
}

export function App() {
	return (
		<ToastProvider>
			<GlobalListeners />
			<BrowserRouter>
				<Routes>
					<Route element={<Layout />}>
						<Route index element={<HomePage />} />
						{/* /cockpit is always-mounted in Layout (see Layout.tsx) — no route entry needed */}
						<Route path="/work" element={<Suspense fallback={<PageLoader />}><WorkPage /></Suspense>} />
						<Route path="/agents" element={<Suspense fallback={<PageLoader />}><AgentsPage /></Suspense>} />
						<Route path="/threads" element={<Suspense fallback={<PageLoader />}><ThreadsPage /></Suspense>} />
						<Route path="/threads/:id" element={<Suspense fallback={<PageLoader />}><ThreadDetailPage /></Suspense>} />
						<Route path="/knowledge" element={<Suspense fallback={<PageLoader />}><KnowledgePage /></Suspense>} />
						<Route path="/logs" element={<Suspense fallback={<PageLoader />}><LogsPage /></Suspense>} />
						<Route path="/settings" element={<Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>} />
						{/* Pages accessible via direct URL but removed from nav */}
						<Route path="/traces" element={<Suspense fallback={<PageLoader />}><TracesPage /></Suspense>} />
						<Route path="/models" element={<Suspense fallback={<PageLoader />}><ModelsPage /></Suspense>} />
						<Route path="/activity" element={<Suspense fallback={<PageLoader />}><ActivityFeedPage /></Suspense>} />
						<Route path="/transaction" element={<Suspense fallback={<PageLoader />}><TransactionPage /></Suspense>} />
						<Route path="/control" element={<Suspense fallback={<PageLoader />}><ControlStationPage /></Suspense>} />
						<Route path="/operations" element={<WorkspaceOperationsRedirectPage />} />
						{/* Redirects for old bookmarks */}
						<Route path="/proposals" element={<Navigate to="/work" replace />} />
						<Route path="/tasks" element={<Navigate to="/work" replace />} />
						<Route path="/config" element={<Navigate to="/settings" replace />} />
						<Route path="/scheduler" element={<Navigate to="/settings" replace />} />
						<Route path="/channels" element={<Navigate to="/settings" replace />} />
						<Route path="/costs" element={<Navigate to="/agents" replace />} />
						<Route path="/devices" element={<Navigate to="/settings" replace />} />
						<Route path="/system" element={<Navigate to="/settings" replace />} />
						<Route path="*" element={<NotFoundPage />} />
					</Route>
				</Routes>
			</BrowserRouter>
		</ToastProvider>
	);
}
