import type { ThreadChange } from "./chat-runtime";
import { toDisplayPath, toDisplayPathSegments } from "./display-path";

export interface ChangeTreeNode {
	id: string;
	label: string;
	path: string;
	rawPath?: string;
	displayPath: string;
	type: "folder" | "file";
	children: ChangeTreeNode[];
	change?: ThreadChange;
}

type MutableTreeNode = {
	id: string;
	label: string;
	path: string;
	rawPath?: string;
	displayPath: string;
	type: "folder" | "file";
	children: Map<string, MutableTreeNode>;
	change?: ThreadChange;
};

export function uniqueThreadChanges(changes: ThreadChange[]): ThreadChange[] {
	const latestByPath = new Map<string, ThreadChange>();
	for (const change of changes) {
		const displayPath = toDisplayPath(change.filePath);
		const existing = latestByPath.get(displayPath);
		if (!existing || existing.timestamp <= change.timestamp) {
			latestByPath.set(displayPath, change);
		}
	}
	return [...latestByPath.values()].sort((a, b) => toDisplayPath(a.filePath).localeCompare(toDisplayPath(b.filePath)));
}

export function buildChangeTree(changes: ThreadChange[]): ChangeTreeNode[] {
	const root = new Map<string, MutableTreeNode>();

	for (const change of uniqueThreadChanges(changes)) {
		const displayPath = toDisplayPath(change.filePath);
		const parts = toDisplayPathSegments(change.filePath);
		if (parts.length === 0) continue;
		let branch = root;
		let currentDisplayPath = "";

		for (let index = 0; index < parts.length; index += 1) {
			const label = parts[index];
			currentDisplayPath = currentDisplayPath ? `${currentDisplayPath}/${label}` : label;
			const isFile = index === parts.length - 1;
			let node = branch.get(label);
			if (!node) {
				node = {
					id: currentDisplayPath,
					label,
					path: currentDisplayPath,
					rawPath: isFile ? change.filePath : undefined,
					displayPath: currentDisplayPath,
					type: isFile ? "file" : "folder",
					children: new Map(),
				};
				branch.set(label, node);
			}
			if (isFile) {
				node.id = displayPath;
				node.type = "file";
				node.path = displayPath;
				node.rawPath = change.filePath;
				node.displayPath = displayPath;
				node.change = change;
			}
			branch = node.children;
		}
	}

	return [...root.values()].map(finalizeTree).sort(sortTree);
}

function finalizeTree(node: MutableTreeNode): ChangeTreeNode {
	return {
		id: node.id,
		label: node.label,
		path: node.path,
		rawPath: node.rawPath,
		displayPath: node.displayPath,
		type: node.type,
		change: node.change,
		children: [...node.children.values()].map(finalizeTree).sort(sortTree),
	};
}

function sortTree(a: ChangeTreeNode, b: ChangeTreeNode): number {
	if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
	return a.label.localeCompare(b.label);
}
