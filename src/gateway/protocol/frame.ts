import { z } from "zod";
import { uuid } from "../src/lib/utils";

export const frameErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const frameSchema = z.object({
  type: z.enum(["req", "res", "event"]),
  id: z.string(),
  method: z.string(),
  payload: z.unknown(),
  error: frameErrorSchema.optional(),
});

export type Frame = z.infer<typeof frameSchema>;
export type FrameError = z.infer<typeof frameErrorSchema>;

export function requestFrame(method: string, payload: unknown): Frame {
  return { type: "req", id: uuid(), method, payload };
}

export function responseFrame(id: string, method: string, payload: unknown, error?: FrameError): Frame {
  return { type: "res", id, method, payload, ...(error ? { error } : {}) };
}

export function eventFrame(method: string, payload: unknown): Frame {
  return { type: "event", id: uuid(), method, payload };
}
