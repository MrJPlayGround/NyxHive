#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { postmanToMarkdown } from "./postman-converter.js";
import { logger } from "../utils/logger.js";

const inputDir = process.argv[2];
const outputDir = process.argv[3];

if (!inputDir || !outputDir) {
  logger.info(`
  Usage: bun run src/templates/process-postman.ts <input-dir> <output-dir>

  Converts Postman JSON collections to markdown for knowledge ingestion.

  Example:
    bun run src/templates/process-postman.ts \\
      "/home/user/dev/obsidian/Acme Knowledge Base/Resources/Postman" \\
      "/home/user/dev/obsidian/Acme Knowledge Base/Resources/Postman-Markdown"
`);
  process.exit(1);
}

if (!existsSync(inputDir)) {
  logger.error(`Input directory not found: ${inputDir}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const files = readdirSync(inputDir).filter(f => f.endsWith(".json"));
logger.info(`Processing ${files.length} Postman collections...\n`);

let converted = 0;
let skipped = 0;

for (const file of files) {
  const inputPath = join(inputDir, file);
  const outputFile = `${basename(file, ".json")}.md`;
  const outputPath = join(outputDir, outputFile);

  try {
    const raw = readFileSync(inputPath, "utf-8");
    const collection = JSON.parse(raw);

    // Validate it looks like a Postman collection
    if (!collection.info?.name || !collection.item) {
      logger.info(`  skip  ${file} (not a Postman collection)`);
      skipped++;
      continue;
    }

    const markdown = postmanToMarkdown(collection);
    writeFileSync(outputPath, markdown);
    logger.info(`  done  ${file} -> ${outputFile}`);
    converted++;
  } catch (err) {
    logger.error(`  fail  ${file}: ${err}`);
    skipped++;
  }
}

logger.info(`\n${converted} converted, ${skipped} skipped`);
