import { create } from "zustand";
import { persist } from "zustand/middleware";
import { uuid } from "../lib/utils";

export interface Notification {
	id: string;
	type: "proposal" | "agent" | "thread" | "system" | "error";
	title: string;
	description?: string;
	timestamp: number;
	read: boolean;
	/** Optional link to navigate to */
	link?: string;
}

interface NotificationState {
	notifications: Notification[];
	unreadCount: number;
	/** Add a notification, keeping max 50 */
	push: (n: Omit<Notification, "id" | "timestamp" | "read">) => void;
	markAllRead: () => void;
	markRead: (id: string) => void;
	clear: () => void;
}

export const useNotificationStore = create<NotificationState>()(
	persist(
		(set) => ({
			notifications: [],
			unreadCount: 0,

			push: (n) =>
				set((state) => {
					const notification: Notification = {
						...n,
						id: uuid(),
						timestamp: Date.now(),
						read: false,
					};
					const notifications = [notification, ...state.notifications].slice(0, 50);
					return {
						notifications,
						unreadCount: notifications.filter((x) => !x.read).length,
					};
				}),

			markAllRead: () =>
				set((state) => ({
					notifications: state.notifications.map((n) => ({ ...n, read: true })),
					unreadCount: 0,
				})),

			markRead: (id) =>
				set((state) => {
					const notifications = state.notifications.map((n) =>
						n.id === id ? { ...n, read: true } : n,
					);
					return {
						notifications,
						unreadCount: notifications.filter((x) => !x.read).length,
					};
				}),

			clear: () => set({ notifications: [], unreadCount: 0 }),
		}),
		{
			name: "nyxhive-notifications",
		},
	),
);
