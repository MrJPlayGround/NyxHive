import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

interface ResolveCliBinaryOptions {
  env?: Record<string, string | undefined>;
  extraDirs?: string[];
  extraFiles?: string[];
}

const DEFAULT_SEARCH_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/Applications/cmux.app/Contents/Resources/bin",
];

const KNOWN_BINARY_PATHS: Record<string, string[]> = {
  claude: [
    "/Applications/cmux.app/Contents/Resources/bin/claude",
  ],
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCliBinary(
  binary: string,
  options: ResolveCliBinaryOptions = {},
): string | null {
  if (!binary) return null;
  if (binary.includes("/")) {
    return isExecutable(binary) ? binary : null;
  }

  const envPath = options.env?.PATH ?? process.env.PATH ?? "";
  const searchDirs = [
    ...envPath.split(delimiter).filter(Boolean),
    ...(options.extraDirs ?? []),
    ...DEFAULT_SEARCH_DIRS,
  ];
  const directCandidates = [
    ...(options.extraFiles ?? []),
    ...(KNOWN_BINARY_PATHS[binary] ?? []),
  ];

  const seen = new Set<string>();
  for (const candidate of [
    ...directCandidates,
    ...searchDirs.map((dir) => join(dir, binary)),
  ]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutable(candidate)) return candidate;
  }

  return null;
}

export function getServicePathEntries(extraDirs: string[] = []): string[] {
  const entries = [...DEFAULT_SEARCH_DIRS, ...extraDirs];
  return entries.filter((entry, index) => entries.indexOf(entry) === index);
}
