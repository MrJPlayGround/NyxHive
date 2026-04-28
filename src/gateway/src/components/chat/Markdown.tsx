import { useCallback, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
	breaks: true,
	gfm: true,
});

function normalizeInlineLists(content: string): string {
	return content
		// Turn `Label: 1) foo, 2) bar` into a real ordered list.
		.replace(/([:;])\s+1\)\s+/g, "$1\n\n1. ")
		.replace(/,\s+(\d+)\)\s+/g, "\n$1. ")
		// Also normalize line-start `1)` markers into markdown ordered-list syntax.
		.replace(/(^|\n)(\d+)\)\s+/g, "$1$2. ");
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export const MARKDOWN_SANITIZE_CONFIG = {
	FORBID_ATTR: ["style"],
	FORBID_TAGS: ["iframe", "object", "embed", "style", "link", "meta"],
} as const;

export function renderMarkdownRaw(content: string): string {
	const normalized = normalizeInlineLists(content);
	const renderer = new marked.Renderer();
	const renderTable = renderer.table.bind(renderer);

	renderer.code = ({ text, lang }) => {
		const label = lang?.trim() || "text";
		return [
			'<div class="md-code-block">',
			'<div class="md-code-head">',
			`<span class="md-code-lang">${escapeHtml(label)}</span>`,
			`<button type="button" class="md-code-copy" data-copy-code="${encodeURIComponent(text)}">Copy</button>`,
			"</div>",
			`<pre><code class="language-${escapeHtml(label)}">${escapeHtml(text)}</code></pre>`,
			"</div>",
		].join("");
	};

	renderer.table = (token) => `<div class="md-table-wrap">${renderTable(token)}</div>`;
	renderer.image = ({ href, title, text }) => {
		const safeHref = href ? escapeHtml(href) : "";
		const safeAlt = text ? escapeHtml(text) : "image";
		const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
		return `<img class="md-media" src="${safeHref}" alt="${safeAlt}"${safeTitle} loading="lazy" decoding="async">`;
	};
	renderer.link = ({ href, title, tokens }) => {
		const safeHref = href ? escapeHtml(href) : "#";
		const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
		const external = /^(https?:)?\/\//i.test(href ?? "");
		const target = external ? ' target="_blank" rel="noreferrer noopener"' : "";
		return `<a href="${safeHref}"${safeTitle}${target}>${renderer.parser.parseInline(tokens)}</a>`;
	};

	return marked.parse(normalized, { async: false, renderer }) as string;
}

export function Markdown({ content }: { content: string }) {
	const html = useMemo(() => {
		return DOMPurify.sanitize(renderMarkdownRaw(content), MARKDOWN_SANITIZE_CONFIG);
	}, [content]);

	const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement | null;
		const copyButton = target?.closest<HTMLButtonElement>("[data-copy-code]");
		if (!copyButton) return;
		event.preventDefault();

		const encoded = copyButton.dataset.copyCode;
		if (!encoded) return;

		const code = decodeURIComponent(encoded);
		void navigator.clipboard.writeText(code);

		const previous = copyButton.textContent;
		copyButton.textContent = "Copied";
		window.setTimeout(() => {
			copyButton.textContent = previous ?? "Copy";
		}, 1200);
	}, []);

	return (
		<div
			className="prose-chat text-sm leading-relaxed"
			onClick={handleClick}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
