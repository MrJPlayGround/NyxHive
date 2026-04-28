import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getLaunchdPath,
  getSystemdPath,
  type ServiceConfig,
} from "../cli/service.js";
import { homedir } from "node:os";

const config: ServiceConfig = {
  instanceName: "test-instance",
  instancePath: "/home/user/nyxhive-test",
  port: 3777,
};

describe("generateLaunchdPlist", () => {
  test("generates valid plist XML", () => {
    const plist = generateLaunchdPlist(config);

    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<plist version=\"1.0\">");
  });

  test("includes correct label", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain("dev.nyxai.nyxhive-test-instance");
  });

  test("includes working directory", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain("/home/user/nyxhive-test");
  });

  test("includes bun program arguments", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain("<string>bun</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>src/index.ts</string>");
  });

  test("includes config path in arguments", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain("config.toml");
  });

  test("uses custom config path when provided", () => {
    const customConfig = { ...config, configPath: "/etc/nyxhive/custom.toml" };
    const plist = generateLaunchdPlist(customConfig);
    expect(plist).toContain("/etc/nyxhive/custom.toml");
  });

  test("includes log paths", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain("stdout.log");
    expect(plist).toContain("stderr.log");
  });

  test("sets KeepAlive on failure", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });

  test("includes PATH in environment", () => {
    const plist = generateLaunchdPlist(config);
    expect(plist).toContain(`${homedir()}/.local/bin`);
    expect(plist).toContain("/Applications/cmux.app/Contents/Resources/bin");
    expect(plist).toContain("/opt/homebrew/bin");
  });
});

describe("generateSystemdUnit", () => {
  test("includes Unit section", () => {
    const unit = generateSystemdUnit(config);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=NyxHive instance: test-instance");
    expect(unit).toContain("After=network.target");
  });

  test("includes Service section with restart", () => {
    const unit = generateSystemdUnit(config);
    expect(unit).toContain("[Service]");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("WatchdogSec=60");
  });

  test("includes correct ExecStart", () => {
    const unit = generateSystemdUnit(config);
    expect(unit).toContain("ExecStart=/usr/local/bin/bun run src/index.ts --config");
    expect(unit).toContain("config.toml");
  });

  test("includes working directory", () => {
    const unit = generateSystemdUnit(config);
    expect(unit).toContain("WorkingDirectory=/home/user/nyxhive-test");
  });

  test("includes Install section", () => {
    const unit = generateSystemdUnit(config);
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("uses custom config path when provided", () => {
    const customConfig = { ...config, configPath: "/etc/nyxhive/custom.toml" };
    const unit = generateSystemdUnit(customConfig);
    expect(unit).toContain("/etc/nyxhive/custom.toml");
  });
});

describe("path helpers", () => {
  test("getLaunchdPath returns correct path", () => {
    const path = getLaunchdPath("myapp");
    expect(path).toBe(`${homedir()}/Library/LaunchAgents/dev.nyxai.nyxhive-myapp.plist`);
  });

  test("getSystemdPath returns correct path", () => {
    const path = getSystemdPath("myapp");
    expect(path).toBe("/etc/systemd/system/nyxhive-myapp.service");
  });
});
