/**
 * Learning system — closes feedback loops across the NyxHive platform.
 *
 * Architecture: event-driven hybrid
 * - Reactive listeners: auto-learn from rejections + failures (immediate)
 * - Scheduled analyzers: feedback→soul, scout scoring (periodic)
 * - SDK tool: agents query the knowledge store on-demand
 */

export { registerLearningListeners } from "./listeners.js";
export { generateScoutReport, formatScoutReport, persistScoutReport } from "./analysis.js";
export type { ScoutReport, ScoutTypeStats } from "./analysis.js";
export { distillPatterns } from "./distill.js";
export type { DistillationResult } from "./distill.js";
