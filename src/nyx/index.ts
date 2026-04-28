#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import fleet from "./commands/fleet.js";
import queue from "./commands/queue.js";
import dispatch from "./commands/dispatch.js";
import run from "./commands/run.js";
import task from "./commands/task.js";
import cost from "./commands/cost.js";
import config from "./commands/config.js";
import chat from "./commands/chat.js";
import cockpit from "./commands/cockpit.js";
import contextBudget from "./commands/context-budget.js";
import workspace from "./commands/workspace.js";
import updates from "./commands/updates.js";
import audit from "./commands/audit.js";
import skills from "./commands/skills.js";
import { NYX_VERSION } from "./lib/version.js";

const main = defineCommand({
  meta: {
    name: "nyx",
    version: NYX_VERSION,
    description: "NyxHive lead control plane",
  },
  subCommands: { chat, cockpit, tui: chat, fleet, queue, dispatch, run, task, cost, config, workspace, updates, audit, skills, "context-budget": contextBudget },
});

runMain(main);
