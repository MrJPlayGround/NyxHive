import type { ModelScore } from "./score.js";

export function printReport(scores: ModelScore[], ramUsage: Record<string, number>): void {
  console.log("\n" + "=".repeat(70));
  console.log("LOCAL LLM BENCHMARK RESULTS");
  console.log("=".repeat(70));

  const ranked = [...scores].sort((a, b) =>
    b.accuracy !== a.accuracy ? b.accuracy - a.accuracy : a.avgLatencyMs - b.avgLatencyMs
  );

  console.log("\n## Overall Rankings\n");
  console.log("| Rank | Model | Accuracy | Avg Latency | P95 Latency | RAM (MB) |");
  console.log("|------|-------|----------|-------------|-------------|----------|");
  ranked.forEach((s, i) => {
    const ram = ramUsage[s.model] ?? 0;
    console.log(
      `| ${i + 1} | ${s.model} | ${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.total}) | ${s.avgLatencyMs}ms | ${s.p95LatencyMs}ms | ${ram} |`
    );
  });

  console.log("\n## Per-Category Breakdown\n");
  for (const score of ranked) {
    console.log(`### ${score.model}\n`);
    console.log("| Category | Accuracy |");
    console.log("|----------|----------|");
    for (const [cat, stats] of Object.entries(score.byCategory)) {
      console.log(`| ${cat} | ${(stats.accuracy * 100).toFixed(0)}% (${stats.correct}/${stats.total}) |`);
    }
    console.log();
  }

  const winner = ranked[0];
  console.log("=".repeat(70));
  console.log(`WINNER: ${winner.model} -- ${(winner.accuracy * 100).toFixed(1)}% accuracy, ${winner.avgLatencyMs}ms avg latency`);
  console.log("=".repeat(70));
}
