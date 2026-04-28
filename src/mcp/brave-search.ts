/**
 * Brave Search API client with token bucket rate limiting.
 * Supports web, news, image, video, and local search.
 * No external dependencies — uses native fetch.
 */

const BRAVE_API_BASE = "https://api.search.brave.com/res/v1";

// --- Result types ---

export interface BraveWebResult {
	title: string;
	url: string;
	description: string;
	age?: string;
	extra_snippets?: string[];
}

export interface BraveNewsResult {
	title: string;
	url: string;
	description: string;
	age?: string;
	source?: string;
	thumbnail?: string;
}

export interface BraveImageResult {
	title: string;
	url: string;
	source: string;
	thumbnail: string;
	width?: number;
	height?: number;
}

export interface BraveVideoResult {
	title: string;
	url: string;
	description: string;
	age?: string;
	thumbnail?: string;
	creator?: string;
	duration?: string;
}

export interface BraveLocalResult {
	name: string;
	address: string;
	phone?: string;
	rating?: number;
	review_count?: number;
	url?: string;
	category?: string;
}

// --- Options ---

export interface BraveSearchOptions {
	count?: number;
	freshness?: "pd" | "pw" | "pm" | "py";
	offset?: number;
}

// --- Token bucket rate limiter (5 req/s) ---

const BUCKET_CAPACITY = 5;
const REFILL_INTERVAL_MS = 1000;

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function consumeToken(): boolean {
	const now = Date.now();
	const elapsed = now - lastRefill;
	if (elapsed >= REFILL_INTERVAL_MS) {
		tokens = BUCKET_CAPACITY;
		lastRefill = now;
	}
	if (tokens > 0) {
		tokens--;
		return true;
	}
	return false;
}

/** Reset rate limiter state — for tests only. */
export function _resetRateLimit(): void {
	tokens = BUCKET_CAPACITY;
	lastRefill = Date.now();
}

// --- Shared fetch helper ---

async function braveRequest(endpoint: string, query: string, apiKey: string, params?: Record<string, string>): Promise<unknown> {
	if (!consumeToken()) {
		throw new Error("Rate limited: too many requests per second");
	}

	const url = new URL(`${BRAVE_API_BASE}/${endpoint}`);
	url.searchParams.set("q", query);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined) url.searchParams.set(k, v);
		}
	}

	const res = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Brave Search API error ${res.status}: ${body}`);
	}

	return res.json();
}

// --- Web search ---

export async function braveWebSearch(
	query: string,
	apiKey: string,
	options?: BraveSearchOptions,
): Promise<BraveWebResult[]> {
	const params: Record<string, string> = {};
	if (options?.count) params.count = String(options.count);
	if (options?.freshness) params.freshness = options.freshness;
	if (options?.offset) params.offset = String(options.offset);

	const data = await braveRequest("web/search", query, apiKey, params) as Record<string, unknown>;
	const results: BraveWebResult[] = [];

	const web = data?.web as { results?: Array<Record<string, unknown>> } | undefined;
	if (web?.results && Array.isArray(web.results)) {
		for (const r of web.results) {
			results.push({
				title: (r.title as string) ?? "",
				url: (r.url as string) ?? "",
				description: (r.description as string) ?? "",
				age: r.age as string | undefined,
				extra_snippets: r.extra_snippets as string[] | undefined,
			});
		}
	}

	return results;
}

/** Backwards-compatible alias */
export const braveSearch = braveWebSearch;

// --- News search ---

export async function braveNewsSearch(
	query: string,
	apiKey: string,
	options?: BraveSearchOptions,
): Promise<BraveNewsResult[]> {
	const params: Record<string, string> = {};
	if (options?.count) params.count = String(options.count);
	if (options?.freshness) params.freshness = options.freshness;
	if (options?.offset) params.offset = String(options.offset);

	const data = await braveRequest("news/search", query, apiKey, params) as Record<string, unknown>;
	const results: BraveNewsResult[] = [];

	const news = data?.results as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(news)) {
		for (const r of news) {
			results.push({
				title: (r.title as string) ?? "",
				url: (r.url as string) ?? "",
				description: (r.description as string) ?? "",
				age: r.age as string | undefined,
				source: ((r.meta_url as Record<string, unknown>)?.hostname as string) ?? (r.source as string | undefined),
				thumbnail: ((r.thumbnail as Record<string, unknown>)?.src as string) ?? undefined,
			});
		}
	}

	return results;
}

// --- Image search ---

export async function braveImageSearch(
	query: string,
	apiKey: string,
	options?: Pick<BraveSearchOptions, "count">,
): Promise<BraveImageResult[]> {
	const params: Record<string, string> = {};
	if (options?.count) params.count = String(options.count);

	const data = await braveRequest("images/search", query, apiKey, params) as Record<string, unknown>;
	const results: BraveImageResult[] = [];

	const images = data?.results as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(images)) {
		for (const r of images) {
			const thumb = r.thumbnail as Record<string, unknown> | undefined;
			const props = r.properties as Record<string, unknown> | undefined;
			results.push({
				title: (r.title as string) ?? "",
				url: (r.url as string) ?? "",
				source: ((r.source as string) ?? (r.url as string)) ?? "",
				thumbnail: (thumb?.src as string) ?? (r.url as string) ?? "",
				width: props?.width as number | undefined,
				height: props?.height as number | undefined,
			});
		}
	}

	return results;
}

// --- Video search ---

export async function braveVideoSearch(
	query: string,
	apiKey: string,
	options?: BraveSearchOptions,
): Promise<BraveVideoResult[]> {
	const params: Record<string, string> = {};
	if (options?.count) params.count = String(options.count);
	if (options?.freshness) params.freshness = options.freshness;

	const data = await braveRequest("videos/search", query, apiKey, params) as Record<string, unknown>;
	const results: BraveVideoResult[] = [];

	const videos = data?.results as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(videos)) {
		for (const r of videos) {
			const thumb = r.thumbnail as Record<string, unknown> | undefined;
			results.push({
				title: (r.title as string) ?? "",
				url: (r.url as string) ?? "",
				description: (r.description as string) ?? "",
				age: r.age as string | undefined,
				thumbnail: (thumb?.src as string) ?? undefined,
				creator: r.creator as string | undefined,
				duration: r.duration as string | undefined,
			});
		}
	}

	return results;
}

// --- Local search (via web search with places filter) ---

export async function braveLocalSearch(
	query: string,
	apiKey: string,
	options?: Pick<BraveSearchOptions, "count">,
): Promise<BraveLocalResult[]> {
	const params: Record<string, string> = {
		result_filter: "places",
		count: String(options?.count ?? 5),
	};

	const data = await braveRequest("web/search", query, apiKey, params) as Record<string, unknown>;
	const results: BraveLocalResult[] = [];

	// Local results come under data.locations.results
	const locations = data?.locations as { results?: Array<Record<string, unknown>> } | undefined;
	if (locations?.results && Array.isArray(locations.results)) {
		for (const r of locations.results) {
			const addr = r.addresses as Array<Record<string, unknown>> | undefined;
			const address = addr?.[0];
			results.push({
				name: (r.name as string) ?? "",
				address: address
					? [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode].filter(Boolean).join(", ")
					: "",
				phone: r.phone as string | undefined,
				rating: (r.rating as Record<string, unknown>)?.ratingValue as number | undefined,
				review_count: (r.rating as Record<string, unknown>)?.ratingCount as number | undefined,
				url: r.url as string | undefined,
				category: r.categories as string | undefined,
			});
		}
	}

	return results;
}
