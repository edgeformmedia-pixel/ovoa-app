# Outlook and Microsoft 365

OVOA can read and send Outlook / Hotmail / Microsoft 365 mail and manage the
Outlook calendar, the same way it does Gmail and Google Calendar. The code is in
`jarvis/api/src/microsoft.ts` and the app's Settings > Account shows a
"Connect Outlook" card. It is **off** until the steps below are done. While it's
off there are no Outlook tools, the app card stays hidden, and a turn doesn't
read anything extra.

## What it does

| Tool | What | Asks first? |
|---|---|---|
| `outlook_search` | newest inbox mail, or a search | no |
| `outlook_read` | one email in full | no |
| `outlook_send` | a new email, or a reply (`reply_to`) | yes, unless Approve for me is on or a standing rule covers everyone it goes to |
| `outlook_calendar_events` | the calendar for 1 to 14 days | no |
| `outlook_calendar_create` | a new event, in their time zone | only when it has guests (they get invitations) |

The approvals are the same as Gmail's: `pending_actions`, the app's Approve card,
and a text YES. The standing rules ("don't ask before emailing Pat",
`rules.ts`) cover `outlook_send` as email and `outlook_calendar_create` as
calendar. The agent's own background jobs can't send Outlook mail, the same as
Gmail (`commands.ts`, `agent.ts`). Sent mail and new events show in the
action log.

One Microsoft account per person. Connecting again replaces it.

## Switching it on (the owner)

1. In the Azure portal, go to **Microsoft Entra ID > App registrations > New registration**.
   - Name: OVOA.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**. This lets both work accounts and Outlook.com / Hotmail sign in.
   - Redirect URI: **Web**, `https://api.ovoa.ai/microsoft/callback`.
2. Under **Certificates & secrets**, add a client secret and copy its **Value**. It expires, so put a reminder in for 30 days before.
3. Under **API permissions > Microsoft Graph > Delegated**, add `offline_access`,
   `openid`, `email`, `profile`, `User.Read`, `Mail.ReadWrite`, `Mail.Send` and
   `Calendars.ReadWrite`. None of these need admin consent for personal accounts.
   Some work tenants require their own admin to approve third-party apps, and
   those users will see a message saying so.
4. Set the two values on the Worker:
   ```
   cd jarvis/api
   npx wrangler secret put MS_CLIENT_ID
   npx wrangler secret put MS_CLIENT_SECRET
   ```
   Paste the **Application (client) ID** from the Overview page into
   `MS_CLIENT_ID`, and the secret's Value into `MS_CLIENT_SECRET`.
5. Apply the migration: `npx wrangler d1 migrations apply <db> --remote`
   (0070_microsoft_accounts, along with 0060 to 0069 from the overnight branch).
6. Deploy. The app's Settings > Account shows "Connect Outlook" on its next
   open, and this needs no new app build. The card is already in this branch's
   app code, so the build that ships it must include this branch.

To publish widely, Microsoft wants the app's publisher verified (a Microsoft
Partner Network ID). Before that, people see an "unverified" note on the
consent screen, but they can still connect.

## Switching it off

Delete either secret (`npx wrangler secret delete MS_CLIENT_SECRET`). The tools
and the app card disappear, and the stored tokens are left unused. To also
forget the tokens, run `DELETE FROM microsoft_accounts`.
