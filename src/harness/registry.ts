import type { AgentHarness, HarnessRuntime } from "./types.js";

const HARNESS_REGISTRY = Symbol.for("nyxhive.harness.registry");

type HarnessRegistryState = {
  harnesses: Map<string, AgentHarness>;
};

function state(): HarnessRegistryState {
  const globalState = globalThis as typeof globalThis & { [HARNESS_REGISTRY]?: HarnessRegistryState };
  globalState[HARNESS_REGISTRY] ??= { harnesses: new Map() };
  return globalState[HARNESS_REGISTRY];
}

export function registerHarness(harness: AgentHarness): void {
  state().harnesses.set(harness.id, harness);
}

export function getHarness(id: string): AgentHarness | undefined {
  return state().harnesses.get(id);
}

export function listHarnesses(): AgentHarness[] {
  return [...state().harnesses.values()];
}

export function listHarnessIds(): string[] {
  return [...state().harnesses.keys()].sort();
}

export function clearHarnesses(): void {
  state().harnesses.clear();
}

export function restoreHarnesses(harnesses: AgentHarness[]): void {
  const registry = state().harnesses;
  registry.clear();
  for (const harness of harnesses) registry.set(harness.id, harness);
}

export function selectHarnessForRuntime(runtime: HarnessRuntime): AgentHarness | undefined {
  return listHarnesses()
    .filter((harness) => harness.supports({ runtime }).supported)
    .sort((left, right) => {
      const leftSupport = left.supports({ runtime });
      const rightSupport = right.supports({ runtime });
      const leftPriority = leftSupport.supported ? leftSupport.priority ?? 0 : -Infinity;
      const rightPriority = rightSupport.supported ? rightSupport.priority ?? 0 : -Infinity;
      if (rightPriority !== leftPriority) return rightPriority - leftPriority;
      return left.id.localeCompare(right.id);
    })[0];
}

export async function closeRegisteredHarnesses(): Promise<void> {
  await Promise.all(listHarnesses().map(async (harness) => harness.closeAll?.()));
}
