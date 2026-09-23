import * as MailComposer from "expo-mail-composer";
import * as SMS from "expo-sms";
import { Linking } from "react-native";
import type { PendingAction, PhoneCall, PhoneCaps } from "./api";
import { autoSendTextsPref, SEND_TEXT_SHORTCUT } from "./storage";
import { healthAvailable, healthSummary } from "./health";
import {
  completeReminder,
  createEvent,
  createReminder,
  deleteEvent,
  listEvents,
  listReminders,
  updateEvent,
} from "./phoneCalendar";
import { whereAmI } from "./phoneLocation";
import {
  createContact,
  findContacts,
  resolveRecipient,
  searchContacts,
  updateContact,
  type ContactMatch,
  type Recipient,
} from "./phoneContacts";

/**
 * Everything the assistant does on the iPhone, dispatched by tool name.
 * Tool names and args match api/src/phone.ts.
 */

/**
 * Sent with each chat message so the server offers only the tools this app can run.
 * autoSendTexts rides along so the assistant's wording matches what actually happens:
 * without it the model told the user a text was "ready for you to send" after it had
 * already gone out, and they asked for it again and again.
 *
 * recipientGuard says this build only auto-sends a text to someone it is sure of
 * (runPhoneAction below), so the server can let the model pass a spoken name
 * straight to phone_message_compose instead of searching Contacts first.
 */
export async function phoneCaps(): Promise<PhoneCaps> {
  return {
    lookups: true,
    // Location is offered whether or not it has been granted yet: the tool asks
    // the first time it is used. Gating it on the permission would mean nothing
    // ever asked for the permission, and iOS expects an app to ask at the
    // moment the user wants the thing — which is when they ask what the weather
    // is doing, not on some earlier screen.
    capabilities: ["location", ...(healthAvailable ? ["health"] : [])],
    autoSendTexts: await autoSendTextsPref.get().catch(() => false),
    recipientGuard: true,
  };
}

// ---------- Lookups ----------

const lookups: Record<string, (args: any) => Promise<unknown>> = {
  phone_contacts_search: searchContacts,
  phone_calendar_events: listEvents,
  phone_reminders_list: listReminders,
  phone_health_summary: healthSummary,
  phone_location: whereAmI,
};

/** Runs a lookup the assistant asked for. Errors go back to the assistant as data. */
export async function runPhoneLookup(call: PhoneCall): Promise<unknown> {
  const run = lookups[call.name];
  if (!run) return { error: "This app version can't do that yet." };
  try {
    return await run(call.args);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Lookup failed" };
  }
}

// ---------- Actions ----------

/** What the approval card shows and asks before Approve can be tapped. */
export type Prep =
  | { kind: "none" }
  | { kind: "contact"; name: string; matches: ContactMatch[] }
  | { kind: "recipients"; recipients: Recipient[] };

export type Approval = { contactId?: string; prep?: Prep };

const RECIPIENT_KIND: Record<string, "phone" | "email"> = {
  phone_message_compose: "phone",
  phone_call: "phone",
  phone_email_compose: "email",
};

export async function preparePhoneAction(action: PendingAction): Promise<Prep> {
  const { tool, args } = action.phone!;
  if (tool === "phone_contact_update") {
    return { kind: "contact", name: args.contactName, matches: await findContacts(args.contactName) };
  }
  const kind = RECIPIENT_KIND[tool];
  if (kind) {
    const inputs: string[] = Array.isArray(args.to) ? args.to : [args.to];
    return { kind: "recipients", recipients: await Promise.all(inputs.map((i) => resolveRecipient(i, kind))) };
  }
  return { kind: "none" };
}

function resolved(prep: Prep | undefined) {
  if (prep?.kind !== "recipients") throw new Error("Recipients weren't looked up.");
  const missing = prep.recipients.filter((r) => !r.value);
  if (missing.length) throw new Error(`Couldn't find ${missing.map((r) => r.input).join(", ")} in Contacts.`);
  return prep.recipients.map((r) => r.value!);
}

/** Runs an approved phone action. Returns a short description of what happened. */
export async function runPhoneAction(action: PendingAction, { contactId, prep }: Approval): Promise<string> {
  const { tool, args } = action.phone!;
  switch (tool) {
    case "phone_contact_create":
      return createContact(args as any);
    case "phone_contact_update":
      return updateContact(args as any, contactId);
    case "phone_calendar_create_event":
      return createEvent(args as any);
    case "phone_calendar_update_event":
      return updateEvent(args as any);
    case "phone_calendar_delete_event":
      return deleteEvent(args as any);
    case "phone_reminder_create":
      return createReminder(args as any);
    case "phone_reminder_complete":
      return completeReminder(args as any);

    case "phone_message_compose": {
      // iOS never lets an app send a text by itself: the Messages sheet waits for a tap on Send.
      // The Shortcuts app can, so "Send texts automatically" hands the text to the user's
      // "OVOA Send Text" shortcut as "recipients|message" and comes back here — but only
      // when every recipient is certainly who was meant. A contact that only sounded like
      // the name, or one of two with it, gets the Messages sheet, so a person sees who it's
      // going to before it goes: "Sth Thai Ecker boss" went out to a half match with nobody
      // looking (messages, 2026-09-23 22:00; recipientGuard.ts decides who is certain).
      const unsure = prep?.kind === "recipients" ? prep.recipients.filter((r) => !r.exact) : [];
      const auto = await autoSendTextsPref.get();
      if (auto && !unsure.length) {
        // A line break didn't survive the shortcuts:// URL (the shortcut saw one line and failed on
        // item 2), so the two parts are separated by "|", which the shortcut splits on instead.
        const body = String(args.body ?? "")
          .replace(/\s*[\r\n]+\s*/g, " ")
          .replace(/\|/g, "/")
          .trim();
        const input = `${resolved(prep).join(", ")}|${body}`;
        const url =
          `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(SEND_TEXT_SHORTCUT)}` +
          `&input=text&text=${encodeURIComponent(input)}&x-success=${encodeURIComponent("ovoa://")}`;
        if (!(await Linking.canOpenURL(url))) throw new Error("The Shortcuts app isn't available.");
        await Linking.openURL(url);
        return `handed your text to the "${SEND_TEXT_SHORTCUT}" shortcut`;
      }
      if (!(await SMS.isAvailableAsync())) throw new Error("This device can't send texts.");
      const { result } = await SMS.sendSMSAsync(resolved(prep), args.body);
      if (result === "cancelled") throw new Error("You cancelled the text.");
      if (result === "sent") return "text sent";
      // Said, so the record of the action doesn't claim it went out on its own.
      if (auto) return `opened your text in Messages to check who it's for, instead of sending it: ${unsure.map((r) => r.label).join("; ")}`;
      return "opened your text in Messages";
    }
    case "phone_email_compose": {
      if (!(await MailComposer.isAvailableAsync())) {
        throw new Error("Mail isn't set up on this iPhone. Add an account in the Mail app first.");
      }
      const { status } = await MailComposer.composeAsync({
        recipients: resolved(prep),
        subject: args.subject,
        body: args.body,
      });
      if (status === MailComposer.MailComposerStatus.CANCELLED) throw new Error("You cancelled the email.");
      if (status === MailComposer.MailComposerStatus.SENT) return "email sent";
      if (status === MailComposer.MailComposerStatus.SAVED) return "email saved as a draft";
      return "opened your email in Mail";
    }
    case "phone_call": {
      const [number] = resolved(prep);
      await Linking.openURL(`tel:${number.replace(/[^\d+]/g, "")}`);
      return `calling ${number}`;
    }

    // The Shortcuts app's shortcuts:// URL scheme.
    case "phone_shortcut_run": {
      const input = args.input ? `&input=text&text=${encodeURIComponent(args.input)}` : "";
      await Linking.openURL(`shortcuts://run-shortcut?name=${encodeURIComponent(args.name)}${input}`);
      return `started the "${args.name}" shortcut`;
    }
    case "phone_shortcut_install": {
      // The Shortcuts app downloads the signed file and shows its Add Shortcut screen.
      await Linking.openURL(
        `shortcuts://import-shortcut?url=${encodeURIComponent(args.url)}&name=${encodeURIComponent(args.name)}`,
      );
      return `opened Shortcuts to add "${args.name}"`;
    }
  }
  throw new Error("This app version can't do that yet. Update the app.");
}
