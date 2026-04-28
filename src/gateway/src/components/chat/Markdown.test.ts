import { describe, expect, test } from "bun:test";
import { MARKDOWN_SANITIZE_CONFIG, renderMarkdownRaw } from "./Markdown";

describe("chat markdown renderer", () => {
	test("adds constrained media attributes to markdown images", () => {
		const html = renderMarkdownRaw("![Plot](data:image/png;base64,abc123 \"chart\")");

		expect(html).toContain('class="md-media"');
		expect(html).toContain('loading="lazy"');
		expect(html).toContain('decoding="async"');
		expect(html).toContain('alt="Plot"');
		expect(html).toContain('title="chart"');
	});

	test("keeps raw layout controls blocked by sanitizer config", () => {
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_ATTR).toContain("style");
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toContain("style");
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toContain("iframe");
	});

	test("leaves raw HTML layout controls for DOMPurify to strip", () => {
		const raw = renderMarkdownRaw(
			'<img src="chart.png" style="width: 4000px; height: 2000px"><iframe src="https://example.com"></iframe>',
		);

		expect(raw).toContain("chart.png");
		expect(raw).toContain("style=");
		expect(raw).toContain("iframe");
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_ATTR).toContain("style");
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toContain("iframe");
	});

	test("wraps markdown tables for horizontal containment", () => {
		const html = renderMarkdownRaw("| A | B |\n| - | - |\n| 1 | 2 |");

		expect(html).toContain('class="md-table-wrap"');
	});
});
