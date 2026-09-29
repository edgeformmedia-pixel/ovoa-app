# Instagram: Meta App Review pack

Written 2026-09-28 from `jarvis/api/src/instagram.ts`. If a tool changes there, change this page too.
Nothing in here is submitted. You submit, from the Meta dashboard, after the checklist at the bottom.

## What this is for

Right now the Meta app **OVOA** (Instagram app **OVOA-IG**, id 1084915031133276) is in Development mode, so only
people with a role on the app can connect Instagram. For every OVOA user to connect a Business or Creator account,
each of the 5 permissions needs **Advanced Access**, which needs App Review and Business Verification, and then the
app goes Live.

## How the feature works (what the reviewer needs to understand)

- There is **no Instagram screen in the OVOA app**. Everything happens in conversation with OVOA: by iMessage
  (texting OVOA's number) or by talking/typing to OVOA in the iPhone app. Say "Instagram", "IG" or "insta" so the
  Instagram tools load for that turn.
- **Connect:** "connect my Instagram" → OVOA replies with a link (`https://api.ovoa.ai/instagram/start?s=…`, lasts
  15 minutes) → Instagram's own login and consent screen (`instagram.com/oauth/authorize`) listing the 5
  permissions → back to a page saying "@username is connected to OVOA".
- **Every send, reply, delete and publish waits for the user's YES.** OVOA shows what it will do, and nothing
  happens until the user replies YES by text (or taps Approve in the app). NO cancels. Hiding a comment is the only
  change made without a YES, because it can be undone.
- **No cold DMs.** A DM goes only to someone who wrote to the account in the last 24 hours; OVOA checks this before
  asking for the YES and again before sending, and refuses otherwise.
- **Deletion:** "disconnect Instagram" deletes the token, account row, stored DMs/comments and any waiting
  Instagram actions. Meta's deauthorize and data-deletion callbacks do the same.

## URLs to enter in the dashboard

Instagram > API setup with Instagram business login > Business login settings (and App settings > Basic):

| Field | Value |
|---|---|
| OAuth redirect URI | `https://api.ovoa.ai/instagram/callback` |
| Deauthorize callback URL | `https://api.ovoa.ai/instagram/deauthorize` |
| Data deletion request URL | `https://api.ovoa.ai/instagram/data-deletion` |
| Data deletion instructions (if asked for a page instead) | `https://api.ovoa.ai/instagram/data-deletion` (the same URL opened in a browser is the instructions page) |
| Webhook callback | `https://api.ovoa.ai/instagram/webhook` (fields: `messages`, `comments`) — already set |
| Privacy policy | `https://ovoa.ai/privacy` (see "Privacy policy" below: the Instagram section is drafted, not yet live) |
| Terms of service | `https://ovoa.ai/terms` |
| Platform | Website: `https://ovoa.ai` (Meta: web/mobile web is the only platform for Instagram Login) |

## Before recording

- An OVOA account on Base or Pro (the AI features need a plan), with the texting number linked, and AI consent given.
- A **test Instagram Business or Creator account** added as an Instagram tester on the app (App roles > Roles >
  Instagram testers) and accepted in Instagram (Settings > Website permissions > Apps and websites > Tester invites).
- A **second Instagram account** to play "the customer": it DMs the test account and comments on one of its posts
  shortly before recording (the DM must be less than 24 hours old).
- One photo already posted on the test account, and a public `https://` link to a JPEG for the publish demo.
- Screen-record the iPhone (Control Center > Screen Recording). English UI. Add captions in editing where the
  screen alone doesn't say what's happening. Keep each video under a few minutes.
- Meta requires at least one successful API call per permission before it grants Advanced Access; recording
  these screencasts makes those calls.

One screencast can cover several permissions, but Meta reviews each permission against its own video, so the
simplest route is one video per permission, each starting from the connect step (or a caption saying the account
was connected in the first video).

---

## 1. `instagram_business_basic`

**Feature:** connecting the account, and reading the user's own profile and posts. Tools: `instagram_connect`,
`ig_profile` (username, name, bio, followers, following, post count, account type), `ig_posts` (recent posts:
caption, type, likes, comment count, link, id). Every other Instagram feature also depends on it (it's what
identifies the account at `/me`).

**Screencast:**
1. Caption: "OVOA is a personal assistant people text over iMessage or talk to in the OVOA iPhone app."
2. In Messages, the conversation with OVOA. Type: "connect my Instagram". OVOA replies with a link.
3. Tap the link. Instagram's login screen opens; sign in to the test Business/Creator account.
4. Instagram's consent screen lists the permissions OVOA asks for. Pause on it, then tap Allow.
5. The page "@testaccount is connected to OVOA. Go back to Messages…" appears.
6. Back in Messages, type: "how's my Instagram profile looking?" OVOA replies with the username, bio,
   follower/following and post counts. Cut to the Instagram app's profile to show the same numbers.
7. Type: "what did I post recently on IG?" OVOA lists the recent posts with captions and like/comment counts.

**Justification:**
OVOA is a personal assistant used by text message and voice. Business and Creator account owners connect their
Instagram so they can ask OVOA about it without opening the app. instagram_business_basic is used to identify the
connected account and to read the owner's own profile (username, bio, follower and post counts) and their own
recent posts when they ask, for example "what did I post recently?". It is only used for the account's owner, only
on their request, and the data is not stored beyond the conversation. It is also required by the other Instagram
permissions OVOA requests.

## 2. `instagram_business_manage_messages`

**Feature:** reading the account's DMs and replying to them. Tools: `ig_conversations` (DM conversations with the
last message), `ig_read_conversation` (the recent messages in one conversation), `ig_inbox` (new DMs received
through the `messages` webhook since connecting), `ig_send_dm` (a reply, only within 24 hours of the other
person's last message, after YES), `ig_private_reply` (one private message to someone who commented, after YES).

**Screencast:**
1. Caption: "A customer (a second account) sent the business a DM a few minutes ago."
2. Show the second account's DM on another phone or in a browser, for context.
3. In Messages with OVOA: "any new IG DMs?" OVOA says who wrote and what they said.
4. "read me my conversation with @customer" — OVOA lists the recent messages in that conversation.
5. "reply to @customer on Instagram: yes, we're open until 6 today". OVOA answers that the DM is ready and ends
   with "Reply YES to go ahead, or NO to cancel." **Pause here: nothing has been sent yet.** Show the customer's
   side: no new message.
6. Reply "YES". OVOA confirms "Done: Instagram DM to @customer: …".
7. Show the customer's side: the reply arrived from the business account.
8. Caption + step: "OVOA never starts a conversation." Ask OVOA to DM an account that hasn't written in the last
   24 hours; OVOA declines and explains Instagram only allows replies within 24 hours.
9. (Private reply) "someone commented 'price?' on my last post, DM them the link to my shop". OVOA shows the
   message and asks for YES; reply YES; show the private message arriving on the commenter's side.

**Justification:**
Owners of small business and creator accounts use OVOA to keep up with Instagram DMs while away from the app. With
instagram_business_manage_messages, OVOA tells them when new DMs arrive (through the messages webhook), reads a
conversation back to them on request, and sends the reply they dictate. OVOA never sends a message on its own:
each reply is shown to the owner first and is sent only after they reply YES. It only replies to people who wrote
to the account in the last 24 hours, checks that window before asking and again before sending, and does not send
promotional or unsolicited messages. The private reply to a commenter is likewise one message, approved by the
owner, in answer to that comment. Stored DMs are deleted after 14 days, and all of it when the owner disconnects.

## 3. `instagram_business_manage_comments`

**Feature:** reading and moderating comments on the user's own posts. Tools: `ig_comments` (comments and replies
on one post), `ig_inbox` (new comments received through the `comments` webhook), `ig_reply_comment` (public
reply, after YES), `ig_hide_comment` (hide or unhide, on request), `ig_delete_comment` (after YES).

**Screencast:**
1. Caption: "The second account left comments on the business's post."
2. In Messages with OVOA: "who commented on my latest IG post?" OVOA lists the comments with usernames.
3. "reply to @customer's comment on Instagram: thank you! DM us for sizes". OVOA shows the reply and asks for YES.
   Pause: show the post, no reply yet. Reply YES. Show the reply on the post.
4. "hide the spam comment on my last Instagram post". OVOA hides it. Show it hidden in Instagram
   (Hidden comments). Then "unhide it" to show it's reversible.
5. "delete that Instagram comment". OVOA asks for YES; reply YES; show the comment gone.

**Justification:**
Business and creator account owners use OVOA to keep up with and moderate comments on their own posts by text or
voice. instagram_business_manage_comments lets OVOA read the comments on the owner's posts, tell them about new
ones (comments webhook), post the public reply they dictate, and hide or delete a comment they ask it to. Replies
and deletions are shown to the owner and happen only after they reply YES; hiding happens on their request and can
be undone. OVOA only acts on comments on the connected account's own media.

## 4. `instagram_business_content_publish`

**Feature:** publishing a photo post or a reel to the user's account. Tool: `ig_publish` (image or video from a
public https link, with a caption, after YES).

**Screencast:**
1. Caption: "The owner has a photo hosted at a public link (e.g. on their website)."
2. In Messages with OVOA: "post this to my Instagram: https://…/photo.jpg with the caption 'New arrivals are
   in! #shoplocal'". OVOA shows "Post a photo to Instagram with the caption …" and asks for YES.
3. Pause: show the Instagram profile, no new post yet. Reply YES. OVOA confirms "Done".
4. Show the new post on the Instagram profile with that caption.
5. (Optional) the same with a reel: "post this reel to IG: https://…/clip.mp4 caption '…'".

**Justification:**
Owners use OVOA to post to their business or creator account from a text message: they give OVOA a link to a photo
or video and a caption, OVOA shows exactly what it will post, and it is published only after they reply YES. OVOA
publishes only content the owner provides and asks for, only to their own connected account, and never posts on its
own.

## 5. `instagram_business_manage_insights`

**Feature:** reading the account's own stats. Tool: `ig_insights` (reach, views, profile views, accounts engaged,
follows and unfollows over 1–30 days).

**Screencast:**
1. In Messages with OVOA (or in the app by voice): "how did my Instagram do this week?"
2. OVOA replies with the week's reach, views, profile views, accounts engaged and follower change.
3. Cut to Instagram's Professional dashboard / Insights for the same period to show the numbers match.

**Justification:**
Business and creator account owners ask OVOA how their account is doing ("how did my Instagram do this week?").
instagram_business_manage_insights lets OVOA read the account-level reach, views, profile views, accounts engaged
and follower change for the period they ask about and summarise it in the reply. It reads only the connected
account's own insights, on request, and doesn't store them.

---

## Reviewer instructions (the "how to test" box)

Meta asks for step-by-step login instructions. Suggested text (fill in the bracketed parts; never put a password in
this repo):

> OVOA is an assistant used by iMessage and in an iPhone app (TestFlight beta). The Instagram features are used in
> conversation; there is no separate Instagram screen. The screencasts show the full flow.
> To test yourself: text [OVOA's number] from an iPhone or Mac with iMessage. [Test OVOA account: email + password,
> given in the private credentials field.] Send "connect my Instagram", open the link, sign in with an Instagram
> Business or Creator account, and approve. Then try: "any new IG DMs?", "reply to @name on Instagram: …" (reply
> YES to send), "who commented on my latest IG post?", "post this to my Instagram: <jpeg link> caption …" (reply
> YES), "how did my Instagram do this week?". Say "disconnect Instagram" to remove all Instagram data.

Open question: the reviewer's own number isn't linked to the test OVOA account, so a text from it lands in the
trial. Either link a number you control and do the testing in the video only, or give the reviewer the app's
TestFlight link and the test account instead. Decide before submitting.

## Audit (2026-09-28)

- **Scopes:** exactly the 5 above, in `SCOPES`; each is used by at least one tool (table above). None unused.
- **Webhook:** POST `/instagram/webhook` checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with
  `IG_APP_SECRET`, constant-time compare) before reading anything; a bad signature gets 401. Malformed JSON now
  gets 400 instead of a crash.
- **Tokens:** the 60-day token is AES-GCM encrypted with `TOKEN_ENC_KEY` (`instagram_accounts.token_enc`),
  refreshed within 10 days of expiry, and deleted if it expires or Instagram says it was revoked (error 190).
- **Disconnect (fixed today):** used to delete only the account row. Now `forgetInstagram` unsubscribes the
  account from webhooks, then deletes the account row, stored DMs/comments, pending connect links and any
  Instagram send still waiting for a YES. It does not revoke the token on Instagram's side (the Instagram Login API
  has no revoke call that we use); the token is gone from OVOA, and the user can remove OVOA in Instagram.
- **24-hour window (fixed today):** `ig_send_dm` used to check only that a conversation existed. Now it checks the
  other person wrote in the last 24 hours, before asking for YES and again when the YES comes.
- **Deletion callbacks (new today):** `/instagram/deauthorize` and `/instagram/data-deletion` verify Meta's
  `signed_request` with the app secret and delete that Instagram user's data; data-deletion returns
  `{url, confirmation_code}` and the url shows the status.
- **Not verified end to end:** none of the Instagram calls, the webhook or the callbacks have been exercised
  against real Meta traffic in this change; the signature and 24-hour logic have unit tests
  (`test/instagram.test.ts`). The first test-account run is the real check.
- **Chat history:** what OVOA said about Instagram sits in the conversation and is deleted by the 14-day purge,
  not by disconnect. The deletion page says so.

## Privacy policy

`https://ovoa.ai/privacy` has no Instagram section yet. A draft is committed in ovoa-team on the local branch
`instagram-privacy-draft` (not pushed, not deployed): an "Instagram, if you connect it" section (what's read, what's
stored, 14-day retention, deletion, no selling/ads/training, Deepgram when read aloud), Meta and Sendblue in "Who
gets what", and Instagram in retention and deletion. Review it, merge, and `npm run deploy` in ovoa-team before
submitting: reviewers read the policy.

## What only you can do (in order)

1. **Review and publish the privacy draft** (above).
2. **Business Verification** of the business that owns the Meta app (Business Settings > Security Center >
   Start verification). Advanced Access requires it; it needs legal business documents and can take days.
3. **Tech Provider:** Meta's App Review page asks whether you are a Tech Provider serving multiple businesses.
   OVOA serves many unrelated account owners, so answer yes; the dashboard's App Review > Requirements shows any
   extra Tech Provider steps it wants for your app. Follow what it lists rather than this note.
4. **Dashboard settings:** app icon (1024×1024), category, privacy policy URL, terms URL, business contact email,
   and the deauthorize / data-deletion URLs from the table above.
5. **Remove legacy permissions** `instagram_basic` and `instagram_content_publish` from the app's permissions list
   (App Review > Permissions and features) so they aren't part of the submission; OVOA uses only the
   `instagram_business_*` ones.
6. **Add test accounts:** your test Business/Creator account as an Instagram tester, accept the invite in
   Instagram, and a second account to play the customer.
7. **Record the 5 screencasts** following the scripts above (this also makes the one successful API call per
   permission that Meta requires).
8. **Submit App Review** with the videos, the justifications above and the reviewer instructions.
9. **After approval, switch the app to Live** (top of the dashboard). Until then only testers can connect.
