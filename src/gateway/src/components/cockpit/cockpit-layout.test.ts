import { describe, expect, test } from "bun:test";
import { getCockpitLayoutState } from "./cockpit-layout";

describe("getCockpitLayoutState", () => {
  test("keeps trace hidden when nothing is streaming and no execution events exist", () => {
    expect(
      getCockpitLayoutState({
        focusMode: false,
        traceOpen: false,
        diffOpen: false,
        executionCount: 0,
        changedFileCount: 0,
        streaming: false,
      }),
    ).toEqual({
      showTraceSection: false,
      showTraceDrawer: false,
      showTraceSummary: false,
      showDiffRail: false,
      canToggleDiff: false,
    });
  });

  test("shows collapsed trace summary when activity exists but the drawer is closed", () => {
    expect(
      getCockpitLayoutState({
        focusMode: false,
        traceOpen: false,
        diffOpen: false,
        executionCount: 4,
        changedFileCount: 0,
        streaming: false,
      }),
    ).toMatchObject({
      showTraceSection: true,
      showTraceDrawer: false,
      showTraceSummary: true,
    });
  });

  test("hides the diff rail in focus mode even if diff state is open", () => {
    expect(
      getCockpitLayoutState({
        focusMode: true,
        traceOpen: true,
        diffOpen: true,
        executionCount: 2,
        changedFileCount: 3,
        streaming: true,
      }),
    ).toMatchObject({
      showDiffRail: false,
      canToggleDiff: true,
    });
  });
});
