import { useState, useCallback } from "react";

interface PaginationState<T> {
	items: T[];
	page: number;
	pageSize: number;
	total: number | null;
	totalPages: number | null;
	loading: boolean;
	nextPage: () => void;
	prevPage: () => void;
	setPageSize: (size: number) => void;
	reset: () => void;
	/** Reset to page 1 and immediately refetch (avoids stale page race) */
	resetAndFetch: (pageSize?: number) => void;
	fetch: () => Promise<void>;
}

export function usePagination<T>(
	fetcher: (offset: number, limit: number) => Promise<{ items: T[]; total?: number }>,
	defaultPageSize = 50,
): PaginationState<T> {
	const [items, setItems] = useState<T[]>([]);
	const [page, setPage] = useState(1);
	const [pageSize, setPageSizeState] = useState(defaultPageSize);
	const [total, setTotal] = useState<number | null>(null);
	const [loading, setLoading] = useState(false);

	const totalPages = total !== null ? Math.ceil(total / pageSize) : null;

	const doFetch = useCallback(async (p: number, size: number) => {
		setLoading(true);
		try {
			const offset = (p - 1) * size;
			const result = await fetcher(offset, size);
			setItems(result.items);
			if (result.total !== undefined) setTotal(result.total);
		} finally {
			setLoading(false);
		}
	}, [fetcher]);

	const fetch = useCallback(() => doFetch(page, pageSize), [doFetch, page, pageSize]);

	const nextPage = useCallback(() => {
		const next = page + 1;
		if (totalPages !== null && next > totalPages) return;
		setPage(next);
		doFetch(next, pageSize);
	}, [page, totalPages, pageSize, doFetch]);

	const prevPage = useCallback(() => {
		if (page <= 1) return;
		const prev = page - 1;
		setPage(prev);
		doFetch(prev, pageSize);
	}, [page, pageSize, doFetch]);

	const setPageSize = useCallback((size: number) => {
		setPageSizeState(size);
		setPage(1);
		doFetch(1, size);
	}, [doFetch]);

	/** Reset to page 1 and immediately refetch */
	const resetAndFetch = useCallback((size?: number) => {
		const s = size ?? defaultPageSize;
		setPage(1);
		setTotal(null);
		setItems([]);
		setPageSizeState(s);
		doFetch(1, s);
	}, [doFetch, defaultPageSize]);

	const reset = useCallback(() => {
		setPage(1);
		setTotal(null);
		setItems([]);
	}, []);

	return { items, page, pageSize, total, totalPages, loading, nextPage, prevPage, setPageSize, reset, resetAndFetch, fetch };
}
