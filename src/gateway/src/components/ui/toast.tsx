import { useState, useEffect, useCallback, createContext, useContext } from "react";
import { uuid } from "../../lib/utils";

interface Toast {
	id: string;
	title: string;
	description?: string;
	type?: "success" | "error" | "info";
	action?: { label: string; onClick: () => void };
	duration?: number;
}

interface ToastContextValue {
	addToast: (toast: Omit<Toast, "id">) => void;
}

type ToastInput = Omit<Toast, "id">;

/** Standalone toast function — callable from anywhere (stores, utils) */
let _addToast: ((toast: ToastInput) => void) | null = null;

export function toast(input: ToastInput) {
	if (_addToast) _addToast(input);
	else console.warn("[toast] Provider not mounted yet");
}

export function toast_success(title: string, description?: string) {
	toast({ title, type: "success", description });
}

export function toast_error(title: string, description?: string) {
	toast({ title, type: "error", description });
}

const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

export function useToast() {
	return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const addToast = useCallback((toast: Omit<Toast, "id">) => {
		const id = uuid();
		setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
	}, []);

	// Register standalone toast function
	useEffect(() => {
		_addToast = addToast;
		return () => { _addToast = null; };
	}, [addToast]);

	const removeToast = useCallback((id: string) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	return (
		<ToastContext.Provider value={{ addToast }}>
			{children}
			<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
				{toasts.map((toast) => (
					<ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
				))}
			</div>
		</ToastContext.Provider>
	);
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
	const borderColor = toast.type === "success"
		? "border-l-emerald-500"
		: toast.type === "error"
			? "border-l-red-500"
			: toast.type === "info"
				? "border-l-[var(--nyx-accent)]"
				: "border-l-zinc-700";

	useEffect(() => {
		const defaultDuration = toast.type === "success" ? 4000 : 8000;
		if (!toast.action) {
			const timer = setTimeout(onDismiss, toast.duration ?? defaultDuration);
			return () => clearTimeout(timer);
		}
	}, [toast, onDismiss]);

	return (
		<div
			className={`rounded-lg border border-zinc-700 border-l-4 ${borderColor} bg-zinc-900 p-4 shadow-lg min-w-[320px] max-w-[420px]`}
			style={{
				animation: "toast-slide-in 0.25s ease-out",
			}}
		>
			<style>
				{`@keyframes toast-slide-in {
					from { opacity: 0; transform: translateX(100%); }
					to { opacity: 1; transform: translateX(0); }
				}`}
			</style>
			<div className="flex items-start justify-between gap-3">
				<div className="flex-1">
					<p className="text-sm font-medium text-zinc-100">{toast.title}</p>
					{toast.description && <p className="mt-1 text-xs text-zinc-400">{toast.description}</p>}
				</div>
				<div className="flex items-center gap-2">
					{toast.action && (
						<button
							type="button"
							onClick={() => {
								toast.action!.onClick();
								onDismiss();
							}}
							className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-200 transition-colors"
						>
							{toast.action.label}
						</button>
					)}
					<button
						type="button"
						onClick={onDismiss}
						className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
					>
						&times;
					</button>
				</div>
			</div>
		</div>
	);
}
