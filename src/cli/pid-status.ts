export type SignalProcess = (pid: number, signal?: number | NodeJS.Signals) => void;

export function isPidProbePermissionError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EPERM"
  );
}

export function isPidRunning(
  pid: number,
  signalProcess: SignalProcess = process.kill,
): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return isPidProbePermissionError(error);
  }
}
