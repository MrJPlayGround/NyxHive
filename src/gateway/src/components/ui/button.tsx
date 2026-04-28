import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--nyx-accent)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"bg-[var(--nyx-accent)] text-[var(--nyx-bg)] shadow hover:brightness-110 hover:shadow-[0_0_16px_var(--nyx-accent-glow)]",
				destructive:
					"bg-red-900 text-zinc-50 shadow-sm hover:bg-red-900/90",
				outline:
					"border border-[var(--nyx-line)] bg-transparent shadow-sm hover:bg-[var(--nyx-panel-hover)] hover:border-[var(--nyx-line-strong)] hover:text-[var(--nyx-text)]",
				secondary:
					"bg-[var(--nyx-panel-hover)] text-[var(--nyx-text)] shadow-sm hover:brightness-110",
				ghost: "hover:bg-[var(--nyx-panel-hover)] hover:text-[var(--nyx-text)]",
				link: "text-[var(--nyx-text)] underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-md px-3 text-xs",
				lg: "h-10 rounded-md px-8",
				icon: "h-9 w-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
			<Comp
				className={cn(buttonVariants({ variant, size, className }))}
				ref={ref}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { Button, buttonVariants };
