export interface StartArgs {
  configPath?: string;
  daemon: boolean;
  instanceName?: string;
  brain?: string;
}

export function parseStartArgs(argv: string[]): StartArgs {
  const args = argv;
  let configPath: string | undefined;
  let daemon = false;
  let instanceName: string | undefined;
  let brain: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i] === "--brain" && i + 1 < args.length) {
      brain = args[++i];
    } else if (args[i] === "--daemon" || args[i] === "-d") {
      daemon = true;
    } else if (!args[i].startsWith("--")) {
      instanceName = args[i];
    }
  }

  return { configPath, daemon, instanceName, brain };
}
