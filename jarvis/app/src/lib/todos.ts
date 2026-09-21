import * as Calendar from "expo-calendar/legacy";
import { Platform } from "react-native";
import { api } from "./api";
import { savedToken } from "./auth";
import { onPush } from "./background";
import { devlog } from "./devlog";

// A copy of the day's to-do list in Apple Reminders, for someone without Google
// (the server copies it into Google Tasks itself when there is an account).
// Only lines not yet copied anywhere, so a rebuilt list doesn't come out twice.
// Nothing here asks for permission: onboarding already did, or the list stays in
// OVOA, which is where it lives anyway.

const dayOf = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export async function copyTodosToReminders(token: string) {
  if (Platform.OS !== "ios") return;
  if (!(await Calendar.getRemindersPermissionsAsync().catch(() => null))?.granted) return;
  try {
    const copied: { id: string; externalId: string }[] = [];
    for (const date of [dayOf(0), dayOf(1)]) {
      const { todos } = await api.todos(token, date);
      for (const t of todos.filter((t) => !t.done && !t.synced_to)) {
        const externalId = await Calendar.createReminderAsync(null, {
          title: t.text,
          dueDate: new Date(`${date}T00:00:00`),
          notes: "From OVOA's list for the day",
        });
        copied.push({ id: t.id, externalId });
      }
    }
    if (copied.length) {
      await api.todosSynced(token, copied);
      devlog("agent", `copied ${copied.length} to-do${copied.length === 1 ? "" : "s"} into Reminders`);
    }
  } catch (err) {
    devlog("err", "couldn't copy the to-do list into Reminders", String(err));
  }
}

// "Tomorrow's list is ready" arrived while the app was alive.
onPush("todos", async () => {
  const token = await savedToken();
  if (token) await copyTodosToReminders(token);
});
