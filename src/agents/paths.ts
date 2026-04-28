import { resolve } from "node:path";

export function resolveAgentRuntimePath(baseDir: string, value?: string): string | undefined {
  if (!value) return undefined;
  return resolve(baseDir, value);
}

export function resolveAgentRuntimePaths(baseDir: string, values?: string[]): string[] | undefined {
  if (!values) return undefined;
  return values.map((value) => resolve(baseDir, value));
}
