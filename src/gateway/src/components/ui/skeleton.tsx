import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("animate-pulse rounded-md bg-[var(--nyx-panel-hover)]", className)} {...props} />;
}

export { Skeleton };
