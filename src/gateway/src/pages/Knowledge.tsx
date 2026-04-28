import { useCallback, useEffect, useState } from "react";
import { Search, Database, FileText, Tag, RefreshCw } from "lucide-react";
import {
	useKnowledgeStore,
	type SearchResult,
	type KnowledgeEntry,
	type KnowledgeDigestPage,
} from "../stores/knowledge";
import { useAuthStore } from "../stores/auth";
import { useVisibilityRefresh } from "../hooks/useVisibilityRefresh";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";

function ResultCard({ result }: { result: SearchResult }) {
	return (
		<Card>
			<CardContent className="p-4">
				<div className="flex items-start justify-between gap-2">
					<p className="whitespace-pre-wrap text-sm text-zinc-300">
						{result.content}
					</p>
					<Badge variant="secondary" className="shrink-0 text-xs">
						{(result.score * 100).toFixed(0)}%
					</Badge>
				</div>
				<div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
					<span>{result.source}</span>
					{result.timestamp && (
						<span>&middot; {new Date(result.timestamp).toLocaleDateString()}</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function EntryCard({
	entry,
	onCompile,
	compiling,
}: {
	entry: KnowledgeEntry;
	onCompile: (sourcePath: string) => void;
	compiling: boolean;
}) {
	return (
		<Card>
			<CardContent className="p-4">
				<div className="mb-1 flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<p className="font-medium text-sm text-zinc-200">{entry.title}</p>
							{entry.category && (
								<Badge variant="secondary" className="text-xs">
									{entry.category}
								</Badge>
							)}
						</div>
						{entry.section && (
							<p className="text-xs text-zinc-500">{entry.section}</p>
						)}
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="shrink-0"
						disabled={compiling}
						onClick={() => onCompile(entry.source_path)}
					>
						{compiling ? "Compiling..." : "Compile digest"}
					</Button>
				</div>
				<p className="whitespace-pre-wrap text-sm text-zinc-400 line-clamp-4">
					{entry.content}
				</p>
				<p className="mt-2 text-xs text-zinc-600 truncate">{entry.source_path}</p>
			</CardContent>
		</Card>
	);
}

function DigestCard({
	page,
	onSetStale,
}: {
	page: KnowledgeDigestPage;
	onSetStale: (id: number, stale: boolean) => void;
}) {
	return (
		<Card>
			<CardContent className="p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<p className="font-medium text-sm text-zinc-100">{page.title}</p>
							{page.category && <Badge variant="secondary" className="text-xs">{page.category}</Badge>}
							{page.stale === 1 && <Badge variant="destructive" className="text-xs">stale</Badge>}
						</div>
						<p className="mt-1 text-xs text-zinc-500 truncate">{page.source_path}</p>
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onSetStale(page.id, page.stale !== 1)}
					>
						{page.stale === 1 ? "Restore" : "Mark stale"}
					</Button>
				</div>
				{page.summary && <p className="mt-3 text-sm text-zinc-300">{page.summary}</p>}
				<p className="mt-3 whitespace-pre-wrap text-sm text-zinc-500 line-clamp-5">{page.content}</p>
				<div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-600">
					<span>{page.chunk_count} chunks</span>
					<span>{page.access_count} uses</span>
					<span>updated {new Date(page.updated_at).toLocaleDateString()}</span>
				</div>
			</CardContent>
		</Card>
	);
}

export function KnowledgePage() {
	const {
		query,
		memoryResults,
		knowledgeResults,
		searching,
		digestQuery,
		digestsLoading,
		digestActionSourcePath,
		digestAudit,
		recentEntries,
		digests,
		stats,
		loaded,
		setQuery,
		setDigestQuery,
		search,
		loadInitial,
		loadDigests,
		compileDigest,
		setDigestStale,
		auditDigests,
	} = useKnowledgeStore();
	const reset = useKnowledgeStore((s) => s.reset);

	const [resultLimit, setResultLimit] = useState(25);
	const authenticated = useAuthStore((s) => s.authenticated);

	useEffect(() => {
		if (authenticated) loadInitial();
	}, [authenticated, loadInitial]);

	useVisibilityRefresh(useCallback(() => {
		reset();
		loadInitial();
	}, [reset, loadInitial]));

	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			search();
		},
		[search],
	);

	const hasSearchResults = memoryResults.length > 0 || knowledgeResults.length > 0;

	return (
		<div>
			<h1 className="text-2xl font-semibold">Knowledge</h1>
			<p className="mt-1 text-sm text-zinc-400">Search and browse stored knowledge</p>

			{/* Stats bar */}
			{stats && (
				<div className="mt-4 flex gap-4">
					<div className="flex items-center gap-2 text-sm text-zinc-400">
						<Database className="h-4 w-4" />
						<span>{stats.totalChunks} chunks</span>
					</div>
					<div className="flex items-center gap-2 text-sm text-zinc-400">
						<FileText className="h-4 w-4" />
						<span>{stats.totalFiles} files</span>
					</div>
					<div className="flex items-center gap-2 text-sm text-zinc-400">
						<FileText className="h-4 w-4" />
						<span>{stats.compiledPages ?? 0} digests</span>
					</div>
					{Object.entries(stats.categories).slice(0, 5).map(([cat, count]) => (
						<div key={cat} className="flex items-center gap-1 text-sm text-zinc-500">
							<Tag className="h-3 w-3" />
							<span>{cat}: {count}</span>
						</div>
					))}
				</div>
			)}

			{/* Search */}
			<form onSubmit={handleSubmit} className="mt-4 flex gap-2">
				<Input
					placeholder="Search knowledge..."
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="max-w-md"
				/>
				<Button type="submit" disabled={searching || !query.trim()}>
					<Search className="mr-1 h-4 w-4" />
					{searching ? "Searching..." : "Search"}
				</Button>
			</form>

			{/* Search results */}
			{hasSearchResults && (
				<Tabs defaultValue="memory" className="mt-6">
					<TabsList>
						<TabsTrigger value="memory">
							Memory ({memoryResults.length})
						</TabsTrigger>
						<TabsTrigger value="knowledge">
							Knowledge ({knowledgeResults.length})
						</TabsTrigger>
					</TabsList>
					<TabsContent value="memory">
						<div className="space-y-3">
							{memoryResults.length === 0 ? (
								<p className="py-4 text-sm text-zinc-500">No memory results</p>
							) : (
								memoryResults.map((r, i) => <ResultCard key={i} result={r} />)
							)}
							{memoryResults.length >= resultLimit && (
								<Button
									variant="outline"
									className="w-full"
									onClick={() => {
										const next = resultLimit + 25;
										setResultLimit(next);
										search(next);
									}}
								>
									Show more
								</Button>
							)}
						</div>
					</TabsContent>
					<TabsContent value="knowledge">
						<div className="space-y-3">
							{knowledgeResults.length === 0 ? (
								<p className="py-4 text-sm text-zinc-500">No knowledge results</p>
							) : (
								knowledgeResults.map((r, i) => <ResultCard key={i} result={r} />)
							)}
							{knowledgeResults.length >= resultLimit && (
								<Button
									variant="outline"
									className="w-full"
									onClick={() => {
										const next = resultLimit + 25;
										setResultLimit(next);
										search(next);
									}}
								>
									Show more
								</Button>
							)}
						</div>
					</TabsContent>
				</Tabs>
			)}

			{searching && (
				<div className="mt-6 space-y-3">
					{Array.from({ length: 3 }).map((_, i) => (
						<Skeleton key={i} className="h-24 rounded-xl" />
					))}
				</div>
			)}

			{/* Recent entries (shown when no search results) */}
			{!hasSearchResults && !searching && (
				<div className="mt-6">
					<Tabs defaultValue="digests">
						<div className="mb-3 flex items-center justify-between gap-3">
							<TabsList>
								<TabsTrigger value="digests">Compiled Digests ({digests.length})</TabsTrigger>
								<TabsTrigger value="recent">Recent Chunks ({recentEntries.length})</TabsTrigger>
							</TabsList>
							<form
								className="flex gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									loadDigests();
								}}
							>
								<Input
									placeholder="Filter digests..."
									value={digestQuery}
									onChange={(event) => setDigestQuery(event.target.value)}
									className="w-56"
								/>
								<Button type="submit" variant="outline" size="sm" disabled={digestsLoading}>
									<RefreshCw className="mr-1 h-4 w-4" />
									{digestsLoading ? "Loading..." : "Refresh"}
								</Button>
								<Button type="button" variant="secondary" size="sm" disabled={digestsLoading} onClick={auditDigests}>
									Audit stale
								</Button>
							</form>
						</div>
						{digestAudit && (
							<p className="mb-3 text-xs text-zinc-500">
								Audited {digestAudit.checked} digests · marked {digestAudit.markedStale} stale · restored {digestAudit.restoredFresh} · missing sources {digestAudit.missingSources}
							</p>
						)}
						<TabsContent value="digests">
							{digestsLoading && !digests.length ? (
								<div className="space-y-3">
									{Array.from({ length: 3 }).map((_, i) => (
										<Skeleton key={i} className="h-24 rounded-xl" />
									))}
								</div>
							) : digests.length === 0 ? (
								<p className="py-8 text-center text-sm text-zinc-500">
									No compiled digests yet. Compile one from Recent Chunks.
								</p>
							) : (
								<div className="space-y-3">
									{digests.map((page) => (
										<DigestCard key={page.id} page={page} onSetStale={setDigestStale} />
									))}
								</div>
							)}
						</TabsContent>
						<TabsContent value="recent">
							{!loaded ? (
								<div className="space-y-3">
									{Array.from({ length: 3 }).map((_, i) => (
										<Skeleton key={i} className="h-24 rounded-xl" />
									))}
								</div>
							) : recentEntries.length === 0 ? (
								<p className="py-8 text-center text-sm text-zinc-500">
									No knowledge entries yet
								</p>
							) : (
								<div className="space-y-3">
									{recentEntries.map((entry, i) => (
										<EntryCard
											key={`${entry.source_path}:${entry.section ?? i}`}
											entry={entry}
											onCompile={compileDigest}
											compiling={digestActionSourcePath === entry.source_path}
										/>
									))}
								</div>
							)}
						</TabsContent>
					</Tabs>
				</div>
			)}
		</div>
	);
}
