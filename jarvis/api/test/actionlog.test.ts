// What counts as done. The feed and the "minutes saved" line are built from
// this, so a parked action counted as done would claim credit for an email the
// user never approved.

import { describeToolCall, kindForTool, MINUTES_SAVED, toolSucceeded } from "../src/actionlog";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

eq("an ordinary result is a success", toolSucceeded({ created: true }), true);
eq("an error is not", toolSucceeded({ error: "no" }), false);
eq("waiting for approval is not done yet", toolSucceeded({ status: "waiting_for_user_approval" }), false);
eq("running on the phone is not done yet", toolSucceeded({ status: "running_on_phone" }), false);
eq("nothing is not a success", toolSucceeded(null), false);

eq("sending mail is logged", kindForTool("gmail_send"), "email_send");
eq("a lookup is not", kindForTool("calendar_list_events"), null);
eq("a phone reminder is a reminder", kindForTool("phone_reminder_create"), "reminder");
eq("food isn't: the Calorie screen is its record", kindForTool("food_log") === null && kindForTool("food_amend") === null, true);

// Every kind a tool maps to has an estimate, or it would silently count as zero.
for (const name of ["gmail_send", "calendar_create_event", "phone_message_compose", "docs_create", "note_add", "routine_confirm"]) {
  const kind = kindForTool(name)!;
  eq(`${kind} has a minutes estimate`, typeof MINUTES_SAVED[kind], "number");
}

eq("described by its title", describeToolCall("calendar_create_event", { title: "Dentist" }), "calendar create event: Dentist");
eq("prefix dropped", describeToolCall("phone_reminder_create", { title: "Milk" }), "reminder create: Milk");
eq("no title, just the name", describeToolCall("tasks_complete", {}), "tasks complete");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
