import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { getServicePathEntries } from "../utils/cli-path.js";

export interface ServiceConfig {
  instanceName: string;
  instancePath: string;
  port?: number;
  configPath?: string;
}

export interface ServiceResult {
  success: boolean;
  path: string;
  message: string;
}

/**
 * Generate a macOS launchd plist for auto-restart.
 */
export function generateLaunchdPlist(config: ServiceConfig): string {
  const label = `dev.nyxai.nyxhive-${config.instanceName}`;
  const absPath = resolve(config.instancePath);
  const configArg = config.configPath
    ? resolve(config.configPath)
    : join(absPath, "config.toml");
  const logDir = join(absPath, "data", "logs");
  const servicePath = getServicePathEntries().join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>bun</string>
    <string>run</string>
    <string>src/index.ts</string>
    <string>--config</string>
    <string>${configArg}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${absPath}</string>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(logDir, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, "stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${servicePath}</string>
  </dict>
</dict>
</plist>`;
}

/**
 * Generate a Linux systemd unit file for auto-restart.
 */
export function generateSystemdUnit(config: ServiceConfig): string {
  const absPath = resolve(config.instancePath);
  const configArg = config.configPath
    ? resolve(config.configPath)
    : join(absPath, "config.toml");
  const servicePath = getServicePathEntries().join(":");

  return `[Unit]
Description=NyxHive instance: ${config.instanceName}
After=network.target

[Service]
Type=simple
WorkingDirectory=${absPath}
ExecStart=/usr/local/bin/bun run src/index.ts --config ${configArg}
Restart=on-failure
RestartSec=5
WatchdogSec=60
Environment=PATH=${servicePath}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target`;
}

/**
 * Get the plist path for a launchd service.
 */
export function getLaunchdPath(instanceName: string): string {
  return join(homedir(), "Library", "LaunchAgents", `dev.nyxai.nyxhive-${instanceName}.plist`);
}

/**
 * Get the systemd unit path.
 */
export function getSystemdPath(instanceName: string): string {
  return `/etc/systemd/system/nyxhive-${instanceName}.service`;
}

/**
 * Install the service (launchd on macOS, systemd on Linux).
 */
export function installService(config: ServiceConfig): ServiceResult {
  const os = platform();

  if (os === "darwin") {
    const plistPath = getLaunchdPath(config.instanceName);
    const plistContent = generateLaunchdPlist(config);
    const logDir = join(resolve(config.instancePath), "data", "logs");

    mkdirSync(logDir, { recursive: true });
    writeFileSync(plistPath, plistContent);

    return {
      success: true,
      path: plistPath,
      message: `Installed launchd service. Load with: launchctl load ${plistPath}`,
    };
  }

  if (os === "linux") {
    const unitPath = getSystemdPath(config.instanceName);
    const unitContent = generateSystemdUnit(config);

    writeFileSync(unitPath, unitContent);

    return {
      success: true,
      path: unitPath,
      message: `Installed systemd service. Enable with: sudo systemctl enable --now nyxhive-${config.instanceName}`,
    };
  }

  return {
    success: false,
    path: "",
    message: `Unsupported platform: ${os}. Only macOS (launchd) and Linux (systemd) are supported.`,
  };
}

/**
 * Uninstall the service.
 */
export function uninstallService(instanceName: string): ServiceResult {
  const os = platform();

  if (os === "darwin") {
    const plistPath = getLaunchdPath(instanceName);
    if (!existsSync(plistPath)) {
      return { success: false, path: plistPath, message: "Service not installed" };
    }

    try {
      // Try to unload first (may fail if not loaded)
      Bun.spawnSync(["launchctl", "unload", plistPath], { stdout: "pipe", stderr: "pipe" });
    } catch {
      // Ignore — may not be loaded
    }

    unlinkSync(plistPath);
    return { success: true, path: plistPath, message: "Service uninstalled" };
  }

  if (os === "linux") {
    const unitPath = getSystemdPath(instanceName);
    if (!existsSync(unitPath)) {
      return { success: false, path: unitPath, message: "Service not installed" };
    }

    try {
      Bun.spawnSync(["systemctl", "stop", `nyxhive-${instanceName}`], { stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync(["systemctl", "disable", `nyxhive-${instanceName}`], { stdout: "pipe", stderr: "pipe" });
    } catch {
      // Ignore
    }

    unlinkSync(unitPath);

    try {
      Bun.spawnSync(["systemctl", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
    } catch {
      // Ignore
    }

    return { success: true, path: unitPath, message: "Service uninstalled" };
  }

  return { success: false, path: "", message: `Unsupported platform: ${os}` };
}
