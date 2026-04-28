import { createBackup, listBackups } from "../utils/backup.js";
import { basename } from "node:path";
import { logger } from "../utils/logger.js";

const args = process.argv.slice(3);
const dataDir = "./data";

if (args[0] === "list") {
  const backups = listBackups(dataDir);
  if (backups.length === 0) {
    logger.info("No backups found.");
  } else {
    logger.info(`${backups.length} backup(s):\n`);
    for (const b of backups) {
      const sizeMB = (b.sizeBytes / 1024 / 1024).toFixed(1);
      logger.info(`  ${b.timestamp}  ${sizeMB}MB  [${b.files.join(", ")}]`);
    }
  }
} else {
  const maxBackups = args[0] ? Number.parseInt(args[0]) : 10;
  const result = createBackup({ dataDir, maxBackups });
  if (result.success) {
    logger.info(`Backup created: ${result.backupDir}`);
    logger.info(`Files: ${result.files.map(f => basename(f)).join(", ")}`);
  } else {
    logger.error(`Backup failed: ${result.error}`);
    process.exit(1);
  }
}
