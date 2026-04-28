import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/utils";

interface PaginationProps {
	page: number;
	totalPages: number | null;
	total: number | null;
	pageSize: number;
	loading?: boolean;
	onNext: () => void;
	onPrev: () => void;
	onPageSizeChange?: (size: number) => void;
	className?: string;
}

const pageSizes = [25, 50, 100];

export function Pagination({
	page,
	totalPages,
	total,
	pageSize,
	loading,
	onNext,
	onPrev,
	onPageSizeChange,
	className,
}: PaginationProps) {
	const start = (page - 1) * pageSize + 1;
	const end = total !== null ? Math.min(page * pageSize, total) : page * pageSize;
	const atStart = page <= 1;
	const atEnd = totalPages !== null ? page >= totalPages : false;

	return (
		<div className={cn("flex items-center justify-between pt-4", className)}>
			<div className="text-xs text-zinc-500">
				{total !== null ? (
					<span>Showing {start}-{end} of {total}</span>
				) : (
					<span>Page {page}</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				{onPageSizeChange && (
					<select
						value={pageSize}
						onChange={(e) => onPageSizeChange(Number(e.target.value))}
						className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-400"
					>
						{pageSizes.map((s) => (
							<option key={s} value={s}>{s} / page</option>
						))}
					</select>
				)}
				<Button
					variant="outline"
					size="sm"
					onClick={onPrev}
					disabled={atStart || loading}
				>
					<ChevronLeft className="h-4 w-4" />
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={onNext}
					disabled={atEnd || loading}
				>
					<ChevronRight className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}
