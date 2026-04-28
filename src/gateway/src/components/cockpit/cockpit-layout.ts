export interface CockpitLayoutInput {
  focusMode: boolean;
  traceOpen: boolean;
  diffOpen: boolean;
  executionCount: number;
  changedFileCount: number;
  streaming: boolean;
}

export interface CockpitLayoutState {
  showTraceSection: boolean;
  showTraceDrawer: boolean;
  showTraceSummary: boolean;
  showDiffRail: boolean;
  canToggleDiff: boolean;
}

export function getCockpitLayoutState(
  input: CockpitLayoutInput,
): CockpitLayoutState {
  const showTraceSection = input.streaming || input.executionCount > 0;
  return {
    showTraceSection,
    showTraceDrawer: showTraceSection && input.traceOpen,
    showTraceSummary: showTraceSection && !input.traceOpen,
    showDiffRail: !input.focusMode && input.diffOpen,
    canToggleDiff: input.changedFileCount > 0 || input.diffOpen,
  };
}
