import { create } from "zustand";

export interface ActivityEvent {
  id: string;
  type: "completion" | "proposal" | "delegation" | "watchdog" | "system" | "error";
  agent: string;
  action: string;
  subject: string;
  detail?: string;
  timestamp: number;
}

interface ActivityFeedStore {
  events: ActivityEvent[];
  addEvent: (event: ActivityEvent) => void;
  setEvents: (events: ActivityEvent[]) => void;
}

export const useActivityFeedStore = create<ActivityFeedStore>((set) => ({
  events: [],
  addEvent: (event) =>
    set((state) => {
      if (state.events.some((e) => e.id === event.id)) return state;
      const updated = [event, ...state.events].slice(0, 50);
      return { events: updated };
    }),
  setEvents: (events) => set({ events }),
}));
