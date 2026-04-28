import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-md border border-[var(--nyx-line)] px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--nyx-accent)] focus:ring-offset-2",
	{
		variants: {
			variant: {
				default: "border-transparent bg-[var(--nyx-accent)] text-[var(--nyx-bg)] shadow",
				secondary: "border-transparent bg-[var(--nyx-panel-hover)] text-[var(--nyx-text)]",
				destructive: "border-transparent bg-red-900 text-zinc-50 shadow",
				outline: "text-[var(--nyx-text)]",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
