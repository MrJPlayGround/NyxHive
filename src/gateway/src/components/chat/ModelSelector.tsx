import { Brain, Check, ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Badge } from "../ui/badge";
import type { ChatModelInfo } from "../../stores/chat";

const MODEL_OPTIONS = [
	{ value: "gpt-5.5", label: "GPT-5.5", provider: "Codex" },
	{ value: "gpt-5.4", label: "GPT-5.4", provider: "Codex" },
	{ value: "gpt-5.4-pro", label: "GPT-5.4 Pro", provider: "Codex" },
	{ value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", provider: "OpenRouter" },
	{ value: "openai/gpt-oss-120b", label: "GPT-OSS 120B", provider: "OpenRouter" },
	{ value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "OpenRouter" },
	{ value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "OpenRouter" },
	{ value: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", provider: "OpenRouter" },
	{ value: "MiniMax-M2.5", label: "MiniMax M2.5", provider: "MiniMax" },
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", provider: "Anthropic" },
	{ value: "claude-opus-4-6", label: "Opus 4.6", provider: "Anthropic" },
];

function shortModelName(model: string): string {
	const match = MODEL_OPTIONS.find((option) => option.value === model);
	if (match) return match.label;
	return model
		.replace(/^google\//, "")
		.replace(/^claude-/, "")
		.replace(/^gpt-/, "GPT-")
		.replace(/^MiniMax-/, "MiniMax ");
}

function providerLabel(modelInfo: ChatModelInfo | null): string {
	if (!modelInfo) return "Model";
	if (modelInfo.provider === "openai") return "Codex";
	if (modelInfo.provider === "anthropic") return "Claude";
	if (modelInfo.provider === "openrouter") return "OpenRouter";
	return modelInfo.provider;
}

interface ModelSelectorProps {
	modelInfo: ChatModelInfo | null;
	loading: boolean;
	disabled?: boolean;
	onSelect: (model?: string | null) => void;
}

export function ModelSelector({ modelInfo, loading, disabled, onSelect }: ModelSelectorProps) {
	const currentModel = modelInfo?.model ?? "Loading...";
	const currentProvider = providerLabel(modelInfo);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled || loading}
					className="h-8 rounded-full border border-white/8 bg-white/[0.03] px-3 text-zinc-300 hover:bg-white/[0.06] hover:text-white"
				>
					<Brain className="mr-2 h-3.5 w-3.5" />
					<span className="max-w-[160px] truncate">{shortModelName(currentModel)}</span>
					<ChevronDown className="ml-2 h-3 w-3 opacity-60" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72 border-white/10 bg-zinc-950/98 text-zinc-100">
				<DropdownMenuLabel className="flex items-center justify-between gap-3">
					<span className="text-xs uppercase tracking-[0.24em] text-zinc-500">Model</span>
					<Badge variant="secondary" className="border-white/10 bg-white/[0.04] text-[10px] uppercase tracking-[0.16em] text-zinc-400">
						{currentProvider}
					</Badge>
				</DropdownMenuLabel>
				<DropdownMenuSeparator className="bg-white/8" />
				{MODEL_OPTIONS.map((option) => {
					const selected = option.value === modelInfo?.model;
					return (
						<DropdownMenuItem
							key={option.value}
							onClick={() => onSelect(option.value)}
							className="flex items-center gap-3 py-2.5"
						>
							<div className="flex h-4 w-4 items-center justify-center">
								{selected ? <Check className="h-3.5 w-3.5 text-[var(--nyx-accent)]" /> : null}
							</div>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm text-zinc-100">{option.label}</div>
								<div className="truncate text-[11px] text-zinc-500">{option.provider}</div>
							</div>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator className="bg-white/8" />
				<DropdownMenuItem
					onClick={() => onSelect(null)}
					className="flex items-center gap-3 py-2.5 text-zinc-300"
				>
					<RotateCcw className="h-3.5 w-3.5" />
					<span>Use agent default</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
