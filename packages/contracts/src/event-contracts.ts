import { z } from "zod";

export const ExecuteEventRequestSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const EventLogSchema = z.object({
  at: z.string(),
  eventId: z.string(),
  stage: z.string(),
  message: z.string(),
});

export const ExecuteEventResponseSchema = z.object({
  statePatch: z.record(z.string(), z.unknown()),
  logs: z.array(EventLogSchema),
});

export type ExecuteEventRequest = z.infer<typeof ExecuteEventRequestSchema>;
export type ExecuteEventResponse = z.infer<typeof ExecuteEventResponseSchema>;
export type EventLog = z.infer<typeof EventLogSchema>;
