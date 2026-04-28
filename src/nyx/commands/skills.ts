import { defineCommand } from "citty";
import pc from "picocolors";
import { auditSkills, exportSkillCatalog } from "../../agents/skill-loader.js";
import { table } from "../lib/format.js";

const audit = defineCommand({
  meta: { name: "audit", description: "Audit SKILL.md frontmatter portability" },
  args: {
    generated: { type: "boolean", description: "Include generated auto-skills" },
    json: { type: "boolean", description: "Print JSON" },
    export: { type: "boolean", description: "Print portable skill catalog JSON" },
  },
  run({ args }) {
    const report = auditSkills({ includeGenerated: Boolean(args.generated) });
    if (args.export) {
      console.log(JSON.stringify(exportSkillCatalog(report), null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }

    const rows = report.skills.map((skill) => [
      skill.status === "pass" ? pc.green("pass") : pc.red("fail"),
      skill.name,
      skill.frontmatter.description || pc.dim("(missing)"),
      skill.issues.join("; "),
    ]);
    console.log(table([
      { label: "State", width: 8 },
      { label: "Skill", width: 24 },
      { label: "Description", width: 48 },
      { label: "Issues", width: 56 },
    ], rows));
    if (!report.ok) process.exitCode = 1;
  },
});

export default defineCommand({
  meta: { name: "skills", description: "Audit and export NyxHive skills" },
  subCommands: { audit },
});
