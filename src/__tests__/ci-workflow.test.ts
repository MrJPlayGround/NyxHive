import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

type WorkflowStep = {
  run?: string;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function loadCiWorkflow(): Workflow {
  const path = new URL("../../.github/workflows/ci.yml", import.meta.url);
  return parseYaml(readFileSync(path, "utf-8")) as Workflow;
}

describe("CI workflow", () => {
  test("uses the repo typecheck script", () => {
    const workflow = loadCiWorkflow();
    const typecheckRuns = workflow.jobs?.typecheck?.steps?.flatMap(step => step.run ?? []) ?? [];
    const allRuns = Object.values(workflow.jobs ?? {}).flatMap(job => (
      job.steps?.flatMap(step => step.run ?? []) ?? []
    ));

    expect(typecheckRuns).toContain("bun run typecheck");
    expect(allRuns).not.toContain("bunx tsc --noEmit");
    expect(allRuns).not.toContain("bun x tsc --noEmit");
  });
});
