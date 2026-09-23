#!/usr/bin/env bash
# End-to-end smoke test of the agent surface, against a local worker.
#
#     npx wrangler dev --local --port 8787 --var DEBUG_KEY:localtest
#     npm run smoke
#
# Everything here runs against real D1 and the real routes, which is what makes
# it worth having: the unit tests cover the clock arithmetic, and this covers
# the things only a running worker can show — that the migrations apply, that
# the defaults are off, that turning the agent on seeds its starting jobs in
# the right timezone, and that one account cannot see or touch another's.
#
# The autonomous turn itself needs a model key, which a local worker has not
# got. So the tick section deliberately tests the failure path instead: what
# the scheduler does when a run cannot complete, which is the part that has to
# behave when nobody is watching anyway.

set -u
API=${API:-http://127.0.0.1:8787}
DEBUG_KEY=${DEBUG_KEY:-localtest}
EMAIL="smoke$(date +%s)@example.com"
pass=0; fail=0

j() { python -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

check() { # check <label> <got> <want>
  if [ "$2" = "$3" ]; then echo "ok   $1: $2"; pass=$((pass+1));
  else echo "FAIL $1: $2  (wanted $3)"; fail=$((fail+1)); fi
}

curl -s -m 3 "$API/" | grep -q jarvis-api || { echo "No worker on $API — start wrangler dev first."; exit 1; }

# Proves a test account's address and agrees to AI, the two things the app's
# first open does (verify.ts, consent.ts), so the sections below can use it.
ready() { # ready <token>
  local id; id=$(curl -s -H "authorization: Bearer $1" "$API/me" | j "d['user']['id']")
  curl -s -o /dev/null -X POST -H "x-debug-key: $DEBUG_KEY" -H 'content-type: application/json' "$API/debug/verify" -d "{\"userId\":\"$id\"}"
  curl -s -o /dev/null -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' "$API/me/consent" -d '{"version":1}'
}

echo "── signup ─────────────────────────────────────────"
SIGNUP=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"name\":\"Smoke\"}")
TOKEN=$(echo "$SIGNUP" | j "d['token']")
[ -n "$TOKEN" ] && { echo "ok   got a token"; pass=$((pass+1)); } || { echo "FAIL no token"; exit 1; }
A=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

echo
echo "── the code step: nothing until the address is proven ──"
# verify.ts. A local worker has no RESEND_API_KEY, so with DEBUG_KEY set the
# code goes to its own log instead of an inbox (emailauth.ts deliverCode), and
# /debug/email/code hands the test a live one.
check "sign-up sent the first code" "$(echo "$SIGNUP" | j "d['codeSent']")" "True"
check "and says the address isn't proven" "$(echo "$SIGNUP" | j "d['user']['emailVerified']")" "False"
ME=$(curl -s "${A[@]}" "$API/me")
check "/me works before the code" "$(echo "$ME" | j "d['user']['emailVerified']")" "False"
check "and says nothing else will" "$(echo "$ME" | j "d['user']['mustVerify']")" "True"
check "nor has it agreed to AI" "$(echo "$ME" | j "d['user']['aiConsent']['given']")" "False"
check "anything else is 403" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" "$API/agent/jobs")" "403"
check "keyed on needs_verification" "$(curl -s "${A[@]}" "$API/routines" | j "d['error']")" "needs_verification"
check "agreeing to AI waits for the code too" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/me/consent" -d '{"version":1}')" "403"
AGAIN=$(curl -s -X POST "${A[@]}" "$API/me/email/code")
check "another code straight away waits" "$(echo "$AGAIN" | j "0 < d['retryAfter'] <= 60")" "True"
check "a live code needs the debug key" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' "$API/debug/email/code" -d "{\"email\":\"$EMAIL\"}")" "404"
CODE=$(curl -s -X POST -H "x-debug-key: $DEBUG_KEY" -H 'content-type: application/json' "$API/debug/email/code" -d "{\"email\":\"$EMAIL\"}" | j "d['code']")
WRONG=$([ "$CODE" = "000000" ] && echo 111111 || echo 000000)
check "a wrong code is refused" "$(curl -s -X POST "${A[@]}" "$API/me/email/verify" -d "{\"code\":\"$WRONG\"}" | j "d['attemptsLeft']")" "4"
check "the right one is taken" "$(curl -s -X POST "${A[@]}" "$API/me/email/verify" -d "{\"code\":\"$CODE\"}" | j "d['emailVerified']")" "True"
check "and /me says so" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['emailVerified']")" "True"
check "everything opens up" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" "$API/agent/jobs")" "200"

echo
echo "── consent: nothing to an AI company before it ────"
# consent.ts. A turn and OVOA's voice are refused before anything is sent;
# every other model call is refused by the gate on the call (plans.ts).
check "a turn is 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/chat" -d '{"message":"hello"}')" "403"
check "keyed on needs_consent" "$(curl -s -X POST "${A[@]}" "$API/chat" -d '{"message":"hello"}' | j "d['error']")" "needs_consent"
check "OVOA's voice too" "$(curl -s -X POST "${A[@]}" "$API/voice/speak" -d '{"text":"Hello there"}' | j "d['error']")" "needs_consent"
check "and a model route that isn't a turn" "$(curl -s -X POST "${A[@]}" "$API/apps/design" -d '{"description":"A grocery helper for my list"}' | j "d['error']")" "needs_consent"
check "Siri hears it as a sentence" "$(curl -s -X POST "${A[@]}" "$API/siri" -d '{"message":"hello"}' | head -c 20)" "Before I can answer,"
AGREED=$(curl -s -X POST "${A[@]}" "$API/me/consent" -d '{"version":1}')
check "agreeing" "$(echo "$AGREED" | j "d['aiConsent']['given']")" "True"
check "/me says so" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['aiConsent']['given']")" "True"
check "a turn gets past it (and finds no engine here)" "$(curl -s -X POST "${A[@]}" "$API/chat" -d '{"message":"hello"}' | j "d.get('error')!='needs_consent'")" "True"
check "taking it back" "$(curl -s -X DELETE "${A[@]}" "$API/me/consent" | j "d['aiConsent']['given']")" "False"
check "stops turns again" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/chat" -d '{"message":"hello"}')" "403"
curl -s -o /dev/null -X POST "${A[@]}" "$API/me/consent" -d '{"version":1}'

echo
echo "── defaults: everything off ───────────────────────"
ME=$(curl -s "${A[@]}" "$API/me")
check "agent off by default"    "$(echo "$ME" | j "d['user']['settings']['agentEnabled']")" "False"
check "timeline off by default" "$(echo "$ME" | j "d['user']['settings']['contextEnabled']")" "False"
check "autonomy default"        "$(echo "$ME" | j "d['user']['settings']['agentAutonomy']")" "suggest"
check "quiet start default"     "$(echo "$ME" | j "d['user']['settings']['quietStart']")" "1320"
check "daily runs default"      "$(echo "$ME" | j "d['user']['settings']['agentDailyRuns']")" "40"

echo
echo "── agent is off: nothing runs, nothing listed ─────"
check "no jobs while off" "$(curl -s "${A[@]}" "$API/agent/jobs" | j "len(d['jobs'])")" "0"
check "no notes while off" "$(curl -s "${A[@]}" "$API/agent/notes" | j "d['unread']")" "0"
check "block refused while timeline off" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/context/blocks" \
     -d '{"startedAt":1,"endedAt":2,"source":"chat","note":"hello"}')" "403"

echo
echo "── turning it on seeds the starting jobs ──────────"
ON=$(curl -s -X PATCH "${A[@]}" "$API/me" \
  -d '{"agentEnabled":true,"contextEnabled":true,"timeZone":"America/New_York"}')
check "agent on"    "$(echo "$ON" | j "d['user']['settings']['agentEnabled']")" "True"
check "timeline on" "$(echo "$ON" | j "d['user']['settings']['contextEnabled']")" "True"
JOBS=$(curl -s "${A[@]}" "$API/agent/jobs")
check "two system jobs seeded" "$(echo "$JOBS" | j "len(d['jobs'])")" "2"
check "morning brief scheduled" "$(echo "$JOBS" | j "[x['when'] for x in d['jobs'] if x['title']=='Morning brief'][0]")" "every day at 7:00 AM"
check "brief always notifies"   "$(echo "$JOBS" | j "[x['notify'] for x in d['jobs'] if x['title']=='Morning brief'][0]")" "always"
check "sweep is quiet unless useful" "$(echo "$JOBS" | j "[x['notify'] for x in d['jobs'] if x['title']!='Morning brief'][0]")" "ifuseful"
# The whole reason the zone is sent with settings: 7am has to be 7am in New York.
NEXT=$(echo "$JOBS" | j "[x['next_run_at'] for x in d['jobs'] if x['title']=='Morning brief'][0]")
check "brief is 7am in New York, not UTC" \
  "$(node -e "process.stdout.write(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date($NEXT)))")" "07:00"
check "seeding is idempotent" \
  "$(curl -s -X PATCH "${A[@]}" "$API/me" -d '{"agentEnabled":true}' >/dev/null; curl -s "${A[@]}" "$API/agent/jobs" | j "len(d['jobs'])")" "2"

echo
echo "── jobs: create, pause, cancel ────────────────────"
JOB=$(curl -s -X POST "${A[@]}" "$API/agent/jobs" \
  -d '{"title":"Watch the inbox","instruction":"Look for anything from the landlord.","kind":"interval","everyMinutes":30}')
JID=$(echo "$JOB" | j "d['id']")
check "job created" "$([ -n "$JID" ] && echo yes)" "yes"
check "reads back as an interval" \
  "$(curl -s "${A[@]}" "$API/agent/jobs" | j "[x['when'] for x in d['jobs'] if x['id']=='$JID'][0]")" "every 30 minutes"
curl -s -o /dev/null -X PATCH "${A[@]}" "$API/agent/jobs/$JID" -d '{"status":"paused"}'
check "paused" "$(curl -s "${A[@]}" "$API/agent/jobs" | j "[x['status'] for x in d['jobs'] if x['id']=='$JID'][0]")" "paused"
check "interval floor enforced" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/agent/jobs" \
     -d '{"title":"Spam","instruction":"x","kind":"interval","everyMinutes":1}')" "400"
curl -s -o /dev/null -X DELETE "${A[@]}" "$API/agent/jobs/$JID"
check "cancelled" "$(curl -s "${A[@]}" "$API/agent/jobs" | j "len([x for x in d['jobs'] if x['id']=='$JID'])")" "0"

echo
echo "── a run that fails is still a run ────────────────"
# A local worker has no model key, so this run cannot succeed. What it proves is
# that the scheduler copes: the job is claimed, the failure is written down, and
# a one-off does not come back from the dead.
ONCE=$(curl -s -X POST "${A[@]}" "$API/agent/jobs" \
  -d '{"title":"Due right now","instruction":"Check something.","kind":"once","inMinutes":1}' | j "d['id']")
# Pull it into the past so the tick picks it up.
curl -s -o /dev/null -X POST "${A[@]}" "$API/debug/agent/due?id=$ONCE" -H "x-debug-key: $DEBUG_KEY"
TICK=$(curl -s -X POST -H "x-debug-key: $DEBUG_KEY" "$API/debug/agent/tick")
check "the tick ran it" "$(echo "$TICK" | j "d['jobsRun']")" "1"
RUNS=$(curl -s "${A[@]}" "$API/agent/runs")
check "the run was logged"   "$(echo "$RUNS" | j "len(d['runs'])")" "1"
check "logged as a failure"  "$(echo "$RUNS" | j "d['runs'][0]['outcome']")" "error"
check "it says what failed"  "$(echo "$RUNS" | j "len(d['runs'][0]['detail']) > 0")" "True"
check "it cost budget"       "$(echo "$RUNS" | j "d['usedToday']")" "1"
check "a failed one-off stays done, not resurrected" \
  "$(curl -s "${A[@]}" "$API/agent/jobs" | j "len([x for x in d['jobs'] if x['id']=='$ONCE'])")" "0"
check "nothing was said"     "$(curl -s "${A[@]}" "$API/agent/notes" | j "len(d['notes'])")" "0"
check "the tick is idempotent" "$(curl -s -X POST -H "x-debug-key: $DEBUG_KEY" "$API/debug/agent/tick" | j "d['jobsRun']")" "0"
check "debug needs the key"  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/debug/agent/tick")" "404"

echo
echo "── goals ──────────────────────────────────────────"
GID=$(curl -s -X POST "${A[@]}" "$API/agent/goals" -d '{"text":"Keep Thursday evenings clear","reason":"family dinner"}' | j "d['id']")
check "goal saved" "$(curl -s "${A[@]}" "$API/agent/goals" | j "len(d['goals'])")" "1"
check "reason kept" "$(curl -s "${A[@]}" "$API/agent/goals" | j "d['goals'][0]['reason']")" "family dinner"
curl -s -o /dev/null -X PATCH "${A[@]}" "$API/agent/goals/$GID" -d '{"status":"met"}'
check "closed goal disappears" "$(curl -s "${A[@]}" "$API/agent/goals" | j "len(d['goals'])")" "0"

echo
echo "── push tokens ────────────────────────────────────"
check "register" "$(curl -s -X POST "${A[@]}" "$API/push/token" -d '{"token":"ExponentPushToken[smoketest123]","platform":"ios"}' | j "d['ok']")" "True"
check "re-register is fine" "$(curl -s -X POST "${A[@]}" "$API/push/token" -d '{"token":"ExponentPushToken[smoketest123]","platform":"ios"}' | j "d['ok']")" "True"
check "short token refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/push/token" -d '{"token":"x"}')" "400"
check "unregister" "$(curl -s -X DELETE "${A[@]}" "$API/push/token?token=ExponentPushToken%5Bsmoketest123%5D" | j "d['ok']")" "True"

echo
echo "── timeline reads ─────────────────────────────────"
check "empty day"  "$(curl -s "${A[@]}" "$API/context/days/2026-09-20" | j "'nothing' in d")" "True"
check "empty week" "$(curl -s "${A[@]}" "$API/context/weeks/2026-09-20" | j "'nothing' in d")" "True"
check "week is derived from the date" "$(curl -s "${A[@]}" "$API/context/weeks/2026-09-20" | j "d['week']")" "2026-W38"
check "bad date refused" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" "$API/context/days/not-a-date")" "400"
check "no commitments yet" "$(curl -s "${A[@]}" "$API/context/commitments" | j "d['open']")" "0"

echo
echo "── other people's data stays theirs ───────────────"
OTHER=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"other$(date +%s)@example.com\",\"password\":\"password123\",\"name\":\"Other\"}" | j "d['token']")
ready "$OTHER"
check "another account sees no jobs" \
  "$(curl -s -H "authorization: Bearer $OTHER" "$API/agent/jobs" | j "len(d['jobs'])")" "0"
check "another account sees no notes" \
  "$(curl -s -H "authorization: Bearer $OTHER" "$API/agent/notes" | j "len(d['notes'])")" "0"
check "can't touch someone else's job" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $OTHER" -H 'content-type: application/json' \
     "$API/agent/jobs/$JID" -d '{"status":"paused"}')" "404"
check "no token, no entry" "$(curl -s -o /dev/null -w '%{http_code}' "$API/agent/jobs")" "401"

echo
echo "── the phone and what it has ──────────────────────"
check "nothing known yet: no band" "$(curl -s "${A[@]}" "$API/capabilities" | j "d['capabilities']['band']")" "False"
CAPS=$(curl -s -X PUT "${A[@]}" "$API/device/state" -d '{"bandLinked":true,"notifications":"granted","health":true,"location":"always","buzzOption":2,"build":"smoke"}')
check "a linked band counts"   "$(echo "$CAPS" | j "d['capabilities']['band']")" "True"
check "Health counts"          "$(echo "$CAPS" | j "d['capabilities']['health']")" "True"
check "always location counts" "$(echo "$CAPS" | j "d['capabilities']['locationAlways']")" "True"
check "no Google here"         "$(echo "$CAPS" | j "d['capabilities']['google']")" "False"
check "bad state refused" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$API/device/state" -d '{"bandLinked":"yes"}')" "400"
check "unlinking is remembered"   "$(curl -s -X PUT "${A[@]}" "$API/device/state" -d '{"bandLinked":false}' | j "d['capabilities']['band']")" "False"
check "another account has its own phone"   "$(curl -s -H "authorization: Bearer $OTHER" "$API/capabilities" | j "d['capabilities']['health']")" "False"

echo
echo "── buzz ───────────────────────────────────────────"
BUZZ=$(curl -s -X POST "${A[@]}" "$API/buzz/test" -d '{"pattern":"double"}')
check "no band: a buzz becomes a notification" "$(echo "$BUZZ" | j "d['via']")" "notification"
check "no push token: nothing reached"         "$(echo "$BUZZ" | j "d['reached']")" "False"
curl -s -o /dev/null -X PUT "${A[@]}" "$API/device/state" -d '{"bandLinked":true}'
check "band linked: a buzz goes to the band" "$(curl -s -X POST "${A[@]}" "$API/buzz/test" | j "d['via']")" "band"

echo
echo "── the agent's commands for the phone ─────────────"
D=(-H "x-debug-key: $DEBUG_KEY")
CID=$(curl -s -X POST "${A[@]}" "${D[@]}" "$API/debug/commands" -d '{"text":"Add milk to my reminders"}' | j "d['id']")
check "queued" "$([ -n "$CID" ] && echo yes)" "yes"
check "queueing needs the debug key"   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/debug/commands" -d '{"text":"x"}')" "404"
PENDING=$(curl -s "${A[@]}" "$API/commands/pending")
check "the phone gets it"          "$(echo "$PENDING" | j "d['commands'][0]['text']")" "Add milk to my reminders"
check "a second drain doesn't"     "$(curl -s "${A[@]}" "$API/commands/pending" | j "len(d['commands'])")" "0"
check "someone else never sees it" "$(curl -s -H "authorization: Bearer $OTHER" "$API/commands/pending" | j "len(d['commands'])")" "0"
check "someone else can't finish it"   "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $OTHER" -H 'content-type: application/json'      "$API/commands/$CID/done" -d '{"ok":true}')" "404"
check "done"             "$(curl -s -X POST "${A[@]}" "$API/commands/$CID/done" -d '{"ok":true,"result":"Added."}' | j "d['ok']")" "True"
check "done only once"   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/commands/$CID/done" -d '{"ok":true}')" "404"
check "listed as done"   "$(curl -s "${A[@]}" "$API/commands" | j "d['commands'][0]['status']")" "done"

echo
echo "── routines and medications ───────────────────────"
SYNC=$(curl -s -X POST "${A[@]}" "$API/routines/sync"   -d '{"source":"apple_reminders","items":[{"externalId":"rem-1","title":"Vitamin D","times":[480]}]}')
check "a reminder becomes a routine" "$(echo "$SYNC" | j "d['routines'][0]['title']")" "Vitamin D"
check "it's a medication"            "$(echo "$SYNC" | j "d['routines'][0]['kind']")" "med"
check "read back"                    "$(echo "$SYNC" | j "d['routines'][0]['when']")" "every day at 8:00 AM"
check "nothing to create"            "$(echo "$SYNC" | j "len(d['toCreate'])")" "0"
RID=$(echo "$SYNC" | j "d['routines'][0]['id']")
check "syncing again doesn't duplicate"   "$(curl -s -X POST "${A[@]}" "$API/routines/sync" -d '{"source":"apple_reminders","items":[{"externalId":"rem-1","title":"Vitamin D","times":[480]}]}' | j "len(d['routines'])")" "1"
check "a time changed in Reminders wins"   "$(curl -s -X POST "${A[@]}" "$API/routines/sync" -d '{"source":"apple_reminders","items":[{"externalId":"rem-1","title":"Vitamin D","times":[540]}]}' | j "d['routines'][0]['when']")" "every day at 9:00 AM"
# Fire it: pull the next occurrence into the past and tick.
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/routines/due?id=$RID"
check "the tick fires it" "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=routines" | j "d['fired'] >= 1")" "True"
check "an occurrence is waiting" "$(curl -s "${A[@]}" "$API/routines" | j "d['routines'][0]['today'][0]['status'] if d['routines'][0]['today'] else 'pending'")" "pending"
check "firing is once" "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=routines" | j "d['fired']")" "0"
CONF=$(curl -s -X POST "${A[@]}" "$API/routines/$RID/confirm" -d '{"via":"app"}')
check "'took it' confirms the waiting one" "$(echo "$CONF" | j "d['title']")" "Vitamin D"
check "nothing left to confirm" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/routines/$RID/confirm" -d '{}')" "404"
check "confirmed in OVOA, so tick it off in Reminders"   "$(curl -s -X POST "${A[@]}" "$API/routines/sync" -d '{"source":"apple_reminders","items":[{"externalId":"rem-1","title":"Vitamin D","times":[540]}]}' | j "d['toWriteBack'][0]['externalId']")" "rem-1"
# Confirmed on the phone before the server fired: recorded, and the tick then says nothing.
FUTURE=$(curl -s "${A[@]}" "$API/routines" | j "d['routines'][0]['nextDueAt']")
check "confirming ahead of the tick" "$(curl -s -X POST "${A[@]}" "$API/routines/$RID/confirm" -d "{\"dueAt\":$FUTURE,\"via\":\"notification\"}" | j "d['title']")" "Vitamin D"
# Escalation: a new occurrence left unconfirmed for over an hour.
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/routines/due?id=$RID&agoMinutes=0"
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/agent/tick?what=routines"
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/routines/due?id=$RID&agoMinutes=20"
# Medication is urgent: it's chased every two minutes by the alarm tick, not at 15 and 60.
check "an urgent med is chased" "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=alarms" | j "d['nagged'] >= 1")" "True"
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/routines/due?id=$RID&agoMinutes=50"
check "but not twice inside two minutes" "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=alarms" | j "d['nagged']")" "0"
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/routines/due?id=$RID&agoMinutes=120"
curl -s -o /dev/null -X POST "${D[@]}" "$API/debug/agent/tick?what=routines"
check "past its window it's missed"   "$(curl -s "${A[@]}" "$API/debug/agent/tick" -o /dev/null; curl -s -X POST "${A[@]}" "$API/routines/$RID/confirm" -d '{}' -o /dev/null -w '%{http_code}')" "404"
check "deleted in Reminders, switched off here"   "$(curl -s -X POST "${A[@]}" "$API/routines/sync" -d '{"source":"apple_reminders","items":[]}' | j "len(d['routines'])")" "0"
check "someone else has no routines" "$(curl -s -H "authorization: Bearer $OTHER" "$API/routines" | j "len(d['routines'])")" "0"

echo
echo "── onboarding ─────────────────────────────────────"
check "a new account isn't onboarded" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['onboarded']")" "False"
ONB=$(curl -s "${A[@]}" "$API/onboarding")
check "it starts with the name"  "$(echo "$ONB" | j "d['step']")" "name"
check "the question uses it"     "$(echo "$ONB" | j "'Smoke' in d['question']")" "True"
check "ten questions"            "$(echo "$ONB" | j "d['total']")" "10"
check "goals come after workouts" "$(curl -s -X POST "${A[@]}" "$API/onboarding/skip" -d '{"step":"gym"}' | j "d['next']['step']")" "goals"
check "and ask about them"       "$(curl -s "${A[@]}" "$API/onboarding" | j "'goals' in d['question']")" "True"
check "skipping moves on"        "$(curl -s -X POST "${A[@]}" "$API/onboarding/skip" -d '{"step":"name"}' | j "d['next']['step']")" "nicknames"
check "an empty answer is refused"   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/onboarding/answer" -d '{"step":"nicknames","text":" "}')" "400"
for s in nicknames wake_sleep work meds pets gym goals routines; do curl -s -o /dev/null -X POST "${A[@]}" "$API/onboarding/skip" -d "{\"step\":\"$s\"}"; done
check "skipping the last one finishes" "$(curl -s -X POST "${A[@]}" "$API/onboarding/skip" -d '{"step":"emergency"}' | j "d['next']['done']")" "True"
check "now onboarded"          "$(curl -s "${A[@]}" "$API/me" | j "d['user']['onboarded']")" "True"
check "restart from Settings"  "$(curl -s -X POST "${A[@]}" "$API/onboarding/restart" | j "d['step']")" "name"
check "finish later"           "$(curl -s -X POST "${A[@]}" "$API/onboarding/finish" | j "d['done']")" "True"
check "the other account is untouched" "$(curl -s -H "authorization: Bearer $OTHER" "$API/me" | j "d['user']['onboarded']")" "False"

echo
echo "── notes ──────────────────────────────────────────"
check "a note is kept" "$(curl -s -X POST "${A[@]}" "$API/notes" -d '{"text":"Wi-Fi password is on the fridge","tags":["house"]}' -o /dev/null -w '%{http_code}')" "201"
curl -s -o /dev/null -X POST "${A[@]}" "$API/notes" -d '{"text":"Buy a gift for Jake","tags":["todo"]}'
check "found by a word"      "$(curl -s "${A[@]}" "$API/notes?q=wifi%20fridge" | j "len(d['notes'])")" "0"
check "found by its words"   "$(curl -s "${A[@]}" "$API/notes?q=password%20fridge" | j "d['notes'][0]['text']")" "Wi-Fi password is on the fridge"
check "listed by tag"        "$(curl -s "${A[@]}" "$API/notes?tag=todo" | j "d['notes'][0]['text']")" "Buy a gift for Jake"
check "not someone else's"   "$(curl -s -H "authorization: Bearer $OTHER" "$API/notes?q=password" | j "len(d['notes'])")" "0"
curl -s -o /dev/null -X POST "${A[@]}" "$API/notes" -d '{"text":"Call the vet","remindAt":"2020-01-01T09:00"}'
check "a due reminder fires once" "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=routines" | j "d['notes']")" "1"
check "and not again"             "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=routines" | j "d['notes']")" "0"

echo
echo "── tomorrow's list ────────────────────────────────"
TOMORROW=$(node -e "const d=new Date(Date.now()+86400000);process.stdout.write(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(d))")
LIST=$(curl -s -X POST "${A[@]}" "$API/todos/build" -d "{\"date\":\"$TOMORROW\"}")
check "a todo note makes the list" "$(echo "$LIST" | j "any(t['text']=='Buy a gift for Jake' for t in d['todos'])")" "True"
check "a plain note doesn't"       "$(echo "$LIST" | j "any('Wi-Fi' in t['text'] for t in d['todos'])")" "False"
TID=$(echo "$LIST" | j "[t['id'] for t in d['todos'] if t['text']=='Buy a gift for Jake'][0]")
check "rebuilding doesn't duplicate"   "$(curl -s -X POST "${A[@]}" "$API/todos/build" -d "{\"date\":\"$TOMORROW\"}" | j "len([t for t in d['todos'] if t['text']=='Buy a gift for Jake'])")" "1"
TID=$(curl -s "${A[@]}" "$API/todos?date=$TOMORROW" | j "[t['id'] for t in d['todos'] if t['text']=='Buy a gift for Jake'][0]")
check "ticked off"                 "$(curl -s -X POST "${A[@]}" "$API/todos/$TID/done" | j "d['ok']")" "True"
check "and the note with it"       "$(curl -s "${A[@]}" "$API/notes?tag=todo" | j "len(d['notes'])")" "0"
check "not someone else's list"    "$(curl -s -H "authorization: Bearer $OTHER" "$API/todos?date=$TOMORROW" | j "len(d['todos'])")" "0"

echo
echo "── food and the Calorie screen ────────────────────"
# food.ts. Logging is a chat turn, which needs a model, so the debug route
# logs exactly as food_log does: the same clamp, catalog and repeat check.
FOODLOG() { curl -s -X POST "${A[@]}" "${D[@]}" "$API/debug/food/log" -d "$1"; }
check "nothing logged, nothing set up" "$(curl -s "${A[@]}" "$API/food" | j "(d['level'], d['chosen'], d['today']['kcal'])")" "(None, False, 0)"
LOGGED=$(FOODLOG '{"items":[{"name":"Olive oil","grams":14,"kcal":40,"category":"fat"},{"name":"Chicken burrito","grams":400,"kcal":900,"protein":40,"category":"mixed"}]}')
check "a tablespoon of oil at 40 kcal is corrected" "$(echo "$LOGGED" | j "[(i['kcal'], i['estimated']) for i in d['items'] if i['name']=='Olive oil'][0]")" "(91, 'clamped')"
check "the day adds up" "$(curl -s "${A[@]}" "$API/food" | j "(d['today']['kcal'], d['today']['protein'], len(d['today']['entries']))")" "(991, 40, 2)"
check "said again a minute later, it isn't logged twice" "$(FOODLOG '{"items":[{"name":"chicken burrito","grams":400,"kcal":900,"category":"mixed"}]}' | j "d['repeats']")" "['chicken burrito']"
AGAIN=$(FOODLOG '{"items":[{"name":"Chicken Burrito","grams":400,"kcal":1000,"category":"mixed"}],"again":true}')
check "a real second one is, and the catalog prices it the same" "$(echo "$AGAIN" | j "(d['items'][0]['kcal'], d['items'][0]['source'])")" "(900, 'catalog')"
BID=$(echo "$AGAIN" | j "d['items'][0]['id']")
check "half of it" "$(curl -s -X PATCH "${A[@]}" "$API/food/log/$BID" -d '{"fraction":0.5}' | j "d['after']")" "450"
check "a weight change carries the calories" "$(curl -s -X PATCH "${A[@]}" "$API/food/log/$BID" -d '{"grams":100}' | j "d['after']")" "225"
OID=$(curl -s "${A[@]}" "$API/food" | j "[e['id'] for e in d['today']['entries'] if e['name']=='Olive oil'][0]")
check "someone else can't fix it" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $OTHER" -H 'content-type: application/json' "$API/food/log/$OID" -d '{"grams":5}')" "404"
check "or remove it" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "authorization: Bearer $OTHER" "$API/food/log/$OID")" "404"
check "or see it" "$(curl -s -H "authorization: Bearer $OTHER" "$API/food" | j "d['today']['entries']")" "[]"
check "removed" "$(curl -s -X DELETE "${A[@]}" "$API/food/log/$OID" | j "d['ok']")" "True"
check "and gone from the day" "$(curl -s "${A[@]}" "$API/food" | j "(d['today']['kcal'], len(d['today']['entries']))")" "(1125, 2)"
check "eaten twice makes the most-eaten list" "$(curl -s "${A[@]}" "$API/food" | j "d['top']")" "[{'name': 'Chicken Burrito', 'times': 2}]"
check "installing Calorie turns on normal" "$(curl -s -X PUT "${A[@]}" "$API/food/settings" -d '{"installed":true}' | j "(d['level'], d['chosen'])")" "('normal', False)"
check "the first question sets the level" "$(curl -s -X PUT "${A[@]}" "$API/food/settings" -d '{"level":"quick"}' | j "(d['level'], d['chosen'])")" "('quick', True)"
check "removing it goes back to quiet" "$(curl -s -X PUT "${A[@]}" "$API/food/settings" -d '{"installed":false}' | j "d['level']")" "None"
check "adding it back keeps the level" "$(curl -s -X PUT "${A[@]}" "$API/food/settings" -d '{"installed":true}' | j "d['level']")" "quick"
check "a daily goal" "$(curl -s -X PUT "${A[@]}" "$API/food/settings" -d '{"kcal":2000}' | j "d['target']['kcal']")" "2000"
check "a made-up level is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$API/food/settings" -d '{"level":"extreme"}')" "400"
check "logging needs the debug key" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/debug/food/log" -d '{"items":[]}')" "404"

echo
echo "── the feed ───────────────────────────────────────"
FEED=$(curl -s "${A[@]}" "$API/feed")
check "it starts with today"        "$(echo "$FEED" | j "d['cards'][0]['kind']")" "summary"
check "what was done is counted"    "$(echo "$FEED" | j "d['cards'][0]['counts'].get('note', 0) >= 2")" "True"
check "the agent's work has a card" "$(echo "$FEED" | j "any(c['kind']=='agent' for c in d['cards'])")" "True"
check "a missed routine shows"      "$(echo "$FEED" | j "any(c['kind']=='missed' for c in d['cards'])")" "True"
check "a quiet account's feed"      "$(curl -s -H "authorization: Bearer $OTHER" "$API/feed" | j "d['cards'][0]['body']")" "Nothing done for you yet today."

echo
echo "── location ───────────────────────────────────────"
NOW=$(node -e "process.stdout.write(String(Date.now()))")
PTS=$(node -e "const n=$NOW;const p=[];for(let i=0;i<8;i++)p.push({ts:n-3600000+i*300000,lat:42.4906+(i%2)*0.0001,lng:-83.1446,accuracy:20});process.stdout.write(JSON.stringify({points:p}))")
check "points become one visit" "$(curl -s -X POST "${A[@]}" "$API/locations" -d "$PTS" | j "d['visits']")" "1"
check "bad points refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/locations" -d '{"points":[{"ts":1,"lat":500,"lng":0}]}')" "400"
check "no places yet"      "$(curl -s "${A[@]}" "$API/places" | j "len(d['places'])")" "0"
check "an unknown place's geofence" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/places/event" -d '{"placeId":"nope","kind":"enter"}')" "404"
check "nightly runs"       "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=nightly" | j "'places' in d")" "True"
check "forget where I've been" "$(curl -s -X DELETE "${A[@]}" "$API/locations" | j "d['ok']")" "True"

echo
echo "── heart rate and workouts ────────────────────────"
HR=$(node -e "const n=$NOW;const s=[];for(let m=0;m<30;m++)s.push({ts:n-7200000+m*60000,bpm:64});for(let m=30;m<60;m++)s.push({ts:n-7200000+m*60000,bpm:140});for(let m=60;m<90;m++)s.push({ts:n-7200000+m*60000,bpm:68});process.stdout.write(JSON.stringify({source:'band',samples:s}))")
check "samples stored"     "$(curl -s -X POST "${A[@]}" "$API/hr" -d "$HR" | j "d['stored']")" "90"
check "again: no duplicates" "$(curl -s -X POST "${A[@]}" "$API/hr" -d "$HR" >/dev/null; curl -s "${A[@]}" "$API/hr/today" | j "d['count']")" "90"
sleep 2
WK=$(curl -s "${A[@]}" "$API/workouts")
check "the raised half hour is a workout" "$(echo "$WK" | j "len(d['workouts'])")" "1"
check "standing still, cardio"            "$(echo "$WK" | j "d['workouts'][0]['kind']")" "cardio"
check "average heart rate"                "$(echo "$WK" | j "d['workouts'][0]['avg_hr']")" "140"
check "found once, not twice"             "$(curl -s -X POST "${A[@]}" "$API/hr" -d "$HR" >/dev/null; sleep 2; curl -s "${A[@]}" "$API/workouts" | j "len(d['workouts'])")" "1"
check "impossible readings refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/hr" -d '{"source":"band","samples":[{"ts":1,"bpm":900}]}')" "400"

echo
echo "── transcripts ────────────────────────────────────"
curl -s -o /dev/null -X POST "${A[@]}" "$API/context/blocks" -d "{\"startedAt\":$NOW,\"endedAt\":$NOW,\"source\":\"voice\",\"transcript\":\"Remember to pick up the dry cleaning on Friday\"}"
TODAY=$(node -e "process.stdout.write(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date($NOW)))")
DAY=$(curl -s "${A[@]}" "$API/transcripts/day/$TODAY")
check "a recording is in today's transcript" "$(echo "$DAY" | j "sum(len(h['blocks']) for h in d['hours']) >= 1")" "True"
check "marked as a recording"                "$(echo "$DAY" | j "'recording' in d['hours'][-1]['blocks'][-1]['sources']")" "True"
check "found by its words" "$(curl -s "${A[@]}" "$API/transcripts/search?q=dry%20cleaning" | j "d['lines'][0]['source']")" "recording"
check "not by someone else" "$(curl -s -H "authorization: Bearer $OTHER" "$API/transcripts/search?q=dry%20cleaning" | j "len(d['lines'])")" "0"
FROM=$((NOW - 1000)); TO=$((NOW + 1000))
check "the words themselves" "$(curl -s "${A[@]}" "$API/transcripts/lines?from=$FROM&to=$TO" | j "d['lines'][0]['text']")" "Remember to pick up the dry cleaning on Friday"
check "forget that"          "$(curl -s -X DELETE "${A[@]}" "$API/transcripts?from=$FROM&to=$TO" | j "d['forgot']")" "1"
check "background needs capture-everything" \
  "$(curl -s "${A[@]}" "$API/transcripts/search?q=dry" | j "len(d['lines'])")" "0"

echo
echo "── people and favors ──────────────────────────────"
check "no people yet"  "$(curl -s "${A[@]}" "$API/people" | j "len(d['people'])")" "0"
check "no favors yet"  "$(curl -s "${A[@]}" "$API/favors" | j "len(d['favors'])")" "0"
check "an unknown favor can't be confirmed" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/favors/nope/confirm")" "404"
check "the feed still builds" "$(curl -s "${A[@]}" "$API/feed" | j "d['cards'][0]['kind']")" "summary"

echo
echo "── daily rhythm ───────────────────────────────────"
check "the old 7am brief is paused" "$(curl -s "${A[@]}" "$API/agent/jobs" | j "[x['status'] for x in d['jobs'] if x['title']=='Morning brief'][0]")" "paused"
check "a brief can be built on demand" "$(curl -s -m 60 "${A[@]}" "$API/brief" | j "len(d['text']) > 0")" "True"
check "the rhythm tick runs" "$(curl -s -m 60 -X POST "${D[@]}" "$API/debug/agent/tick?what=rhythm" | j "'briefs' in d")" "True"

echo
echo "── extras ─────────────────────────────────────────"
check "the extras tick runs" "$(curl -s -m 60 -X POST "${D[@]}" "$API/debug/agent/tick?what=extras" | j "'weekly' in d")" "True"
check "sleep hours are accepted" "$(curl -s -X PUT "${A[@]}" "$API/device/state" -d '{"bandLinked":false,"sleepHours":7.5}' -o /dev/null -w '%{http_code}')" "200"
check "the nightly job learns accounts too" "$(curl -s -m 60 -X POST "${D[@]}" "$API/debug/agent/tick?what=nightly" | j "'accounts' in d")" "True"

echo
echo "── alarms and urgent reminders ────────────────────"
AL=$(curl -s -X POST "${A[@]}" "$API/alarms" -d '{"time":"07:00","hard":true,"label":"Gym"}')
AID=$(echo "$AL" | j "d['id']")
check "an alarm is set" "$([ -n "$AID" ] && echo yes)" "yes"
check "it's listed as hard" "$(curl -s "${A[@]}" "$API/alarms" | j "d['alarms'][0]['hard']")" "True"
check "at 7:00 AM" "$(curl -s "${A[@]}" "$API/alarms" | j "d['alarms'][0]['at']")" "7:00 AM"
check "a bad time is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/alarms" -d '{"time":"7am"}')" "400"
check "nothing to stop when it isn't ringing" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/alarms/$AID/stop" -d '{"steps":0}')" "409"
check "the alarm tick runs" "$(curl -s -X POST "${D[@]}" "$API/debug/agent/tick?what=alarms" | j "'fired' in d")" "True"
check "not someone else's alarms" "$(curl -s -H "authorization: Bearer $OTHER" "$API/alarms" | j "len(d['alarms'])")" "0"
check "cancelled" "$(curl -s -X DELETE "${A[@]}" "$API/alarms/$AID" | j "d['ok']")" "True"
check "a nag can be answered" "$(curl -s -X POST "${A[@]}" "$API/nags/done" -d '{"key":"note:nope"}' | j "d['ok']")" "True"

echo
echo "── capture everything is dev-only ─────────────────"
check "refused for an ordinary account"   "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${A[@]}" "$API/me" -d '{"captureEverything":true}')" "403"
check "still off" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['settings']['captureEverything']")" "False"
check "turning it off is always allowed"   "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${A[@]}" "$API/me" -d '{"captureEverything":false}')" "200"

echo
echo "── signing up, and being told which box is wrong ──"
BLANK=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"fields@example.com","password":"password123","name":"  "}')
check "a blank name names the name"      "$(echo "$BLANK" | j "list(d['fields'])")" "['name']"
SHORT=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"fields@example.com","password":"short","name":"Bob"}')
check "a short password names the password" "$(echo "$SHORT" | j "list(d['fields'])")" "['password']"
BADMAIL=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"not-an-email","password":"password123","name":"Bob"}')
check "a bad address names the address"   "$(echo "$BADMAIL" | j "list(d['fields'])")" "['email']"
# Login stays deliberately vague: it must not say whether an account exists.
NOACC=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"nobody-at-all@example.com","password":"password123"}')
check "an unknown account says nothing more" "$(echo "$NOACC" | j "d['error']")" "Invalid email or password"
check "and offers no per-field hint"         "$(echo "$NOACC" | j "'fields' in d")" "False"

# Whitespace and case: the users table is already NOCASE, so this is the trim
# and the fold, which is what turns " Bob@Example.com " from a wrong password
# into a sign-in.
CASE="case$(date +%s)@example.com"
curl -s -o /dev/null -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"  ${CASE^^}  \",\"password\":\"password123\",\"name\":\"Case\"}"
for FORM in "$CASE" "${CASE^^}" "  $CASE  "; do
  check "signed up shouting, signs in as '$FORM'" \
    "$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
      -d "{\"email\":\"$FORM\",\"password\":\"password123\"}" | j "bool(d.get('token'))")" "True"
done

echo
echo "── what the server knows about itself ─────────────"
check "the log reader needs the key" "$(curl -s -o /dev/null -w '%{http_code}' "$API/debug/logs")" "404"
check "and a wrong key is still not found" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-debug-key: nope' "$API/debug/logs")" "404"

# An older build's upload, with none of the new fields. Every tester's phone is
# on one of those for at least a TestFlight cycle.
check "an old-shape batch is still accepted" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/logs" -H 'content-type: application/json' \
    -d "{\"deviceId\":\"smoke-old-build\",\"sessionId\":\"smoke0\",\"entries\":[{\"time\":$NOW,\"kind\":\"log\",\"text\":\"hello from build 44\"}]}")" "200"

# A voice line, which is the worst case: the words are in the text AND the detail.
curl -s -o /dev/null -X POST "$API/logs" -H 'content-type: application/json' \
  -d "{\"deviceId\":\"smoke-device-01\",\"sessionId\":\"smoke1\",\"build\":\"smoke\",\"entries\":[{\"time\":$NOW,\"kind\":\"voice\",\"level\":\"info\",\"count\":1,\"seq\":1,\"text\":\"heard: \\\"call my mother at four\\\"\",\"detail\":\"call my mother at four\"}]}"
LOGS=$(curl -s "${D[@]}" "$API/debug/logs?since=5m&kind=voice&detail=1")
check "the phone's log is readable" "$(echo "$LOGS" | j "len(d['device']) >= 1")" "True"
check "but not what was said"      "$(echo "$LOGS" | j "'my mother' not in json.dumps(d)")" "True"
check "no detail on a voice line, even when asked for" \
  "$(echo "$LOGS" | j "'detail' not in d['device'][0]")" "True"

# The two kinds that carry words without ever quoting them: an agent row's detail
# is a reminder label or the agent's own command, and a req row's detail is the
# request body — which on /chat is the sentence the user just spoke.
curl -s -o /dev/null -X POST "$API/logs" -H 'content-type: application/json' \
  -d "{\"deviceId\":\"smoke-device-01\",\"sessionId\":\"smoke1\",\"entries\":[{\"time\":$NOW,\"kind\":\"agent\",\"text\":\"reminder going off\",\"detail\":\"Take methotrexate 15mg Sunday\"},{\"time\":$NOW,\"kind\":\"req\",\"text\":\"POST /chat\",\"detail\":\"{\\\"message\\\":\\\"tell my sister I am running late\\\"}\"}]}"
WORDS=$(curl -s "${D[@]}" "$API/debug/logs?since=5m&detail=1&limit=200")
check "an agent line's detail is withheld" "$(echo "$WORDS" | j "'methotrexate' not in json.dumps(d)")" "True"
check "a request body is withheld"         "$(echo "$WORDS" | j "'running late' not in json.dumps(d)")" "True"

# Anything token-shaped, wherever it turns up.
curl -s -o /dev/null -X POST "$API/logs" -H 'content-type: application/json' \
  -d "{\"deviceId\":\"smoke-device-01\",\"sessionId\":\"smoke1\",\"entries\":[{\"time\":$NOW,\"kind\":\"err\",\"text\":\"401 GET /me Bearer 9f8e7d6c5b4a3928170655\"}]}"
ERRS=$(curl -s "${D[@]}" "$API/debug/logs?since=5m&kind=err")
check "tokens are masked" "$(echo "$ERRS" | j "'9f8e7d6c5b4a' not in json.dumps(d)")" "True"
check "the shape survives" "$(echo "$ERRS" | j "any('401' in x['text'] for x in d['device'])")" "True"

# Filters, so a real hunt is possible.
check "kind filters"  "$(echo "$ERRS" | j "all(x['kind']=='err' for x in d['device'])")" "True"
check "text filters"  "$(curl -s "${D[@]}" "$API/debug/logs?since=5m&text=zzzznomatch" | j "len(d['device'])")" "0"
check "limit is honoured" "$(curl -s "${D[@]}" "$API/debug/logs?since=5m&limit=1" | j "len(d['device'])")" "1"

# The beat. This is the one that answers "is the cron firing".
check "a tick can be run by hand" "$(curl -s -m 60 -X POST "${D[@]}" "$API/debug/agent/tick?what=cron" | j "'decided' in d")" "True"
HEALTH=$(curl -s "${D[@]}" "$API/debug/logs?since=5m")
check "the tick was written down" "$(echo "$HEALTH" | j "d['health']['lastTickMs'] is not None")" "True"
check "and it was just now"       "$(echo "$HEALTH" | j "d['health']['lastTickMs'] < 120000")" "True"
curl -s -m 60 -o /dev/null -X POST "${D[@]}" "$API/debug/agent/tick?what=cron"
check "a second tick is counted, not duplicated" \
  "$(curl -s "${D[@]}" "$API/debug/logs?since=5m" | j "d['health']['ticksThisHour'] >= 2")" "True"

# An engine failure is recorded even though the phone got a 200. A local worker
# has no model key, so any turn that needs one fails -- which is the case worth
# proving, because it is the case that used to leave no trace at all. The
# person is told plainly, as a reply, that OVOA can't reach the AI right now:
# read on a typed turn, heard on a spoken one (the sentence is streamed).
NOAI=$(curl -s -m 60 -X POST "${A[@]}" "$API/chat" -d '{"message":"hello","timeZone":"America/New_York"}')
check "no engine: the turn says so plainly" "$(echo "$NOAI" | j "d['messages'][0]['content'].startswith(\"Sorry, I can't reach the AI right now\")")" "True"
check "as a reply no model wrote" "$(echo "$NOAI" | j "d['meta']['engine']")" "none"
check "and a spoken turn hears it" \
  "$(curl -s -m 60 -X POST "${A[@]}" "$API/chat" -d '{"message":"hello","voice":true,"stream":true}' | python -c "import sys,json;ls=[json.loads(l) for l in sys.stdin if l.strip()];print([l['type'] for l in ls if l['type']!='voice'], \"can't reach the AI\" in ls[-2].get('text',''))" 2>/dev/null)" "['sentence', 'done'] True"
check "none of it was saved as conversation" "$(curl -s "${A[@]}" "$API/chat/messages" | j "len(d['messages'])")" "0"
check "a failed turn leaves a fingerprint" \
  "$(curl -s "${D[@]}" "$API/debug/logs?since=5m" | j "len([e for e in d['errors'] if '/chat' in e['route']]) >= 1")" "True"
check "and an engine attempt" \
  "$(curl -s "${D[@]}" "$API/debug/logs?since=5m" | j "len(d['engines']) >= 1")" "True"
# Read-only: there is no POST handler, so the request falls through to the
# authed catch-all and is refused for want of a bearer token. 401 rather than
# 404 is that catch-all answering, and it is the proof either way.
check "the reader writes nothing" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${D[@]}" "$API/debug/logs")" "401"

echo
echo "── what it costs ──────────────────────────────────"
# The phone counts the microphone seconds it streamed and reports them; the
# server files them against the person, priced, and the operator reads everyone.
check "the phone can report mic seconds" \
  "$(curl -s -X POST "${A[@]}" "$API/usage/stream" -d '{"seconds":42.5,"connections":1}' | j "d['ok']")" "True"
check "an absurd report is refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/usage/stream" -d '{"seconds":99999}')" "400"
sleep 1
MINE=$(curl -s "${A[@]}" "$API/usage/me")
check "the seconds show up for the person" "$(echo "$MINE" | j "d['today']['streamSeconds']")" "43"
check "and are priced"                     "$(echo "$MINE" | j "d['today']['microUsd'] > 0")" "True"
check "the mic line is named"              "$(echo "$MINE" | j "'mic' in d['today']['by']")" "True"
check "the month includes today"           "$(echo "$MINE" | j "d['month']['streamSeconds']")" "43"
check "someone else's usage is theirs"     "$(curl -s -H "authorization: Bearer $OTHER" "$API/usage/me" | j "d['today']['streamSeconds']")" "0"
# The month's cap (cap.ts) rides along: the plan's daily replies × 31 (here
# Pro's, since a local worker has no site key), none used yet, nothing said.
check "a month's cap is the plan's: Pro's 1,860" "$(echo "$MINE" | j "d['cap']['limit']")" "1860"
check "none used yet"                       "$(echo "$MINE" | j "d['cap']['used']")" "0"
check "so nothing is said about it"         "$(echo "$MINE" | j "d['cap']['standing']")" "ok"
check "filed under this month"              "$(echo "$MINE" | j "len(d['cap']['month'])")" "7"
EVERYONE=$(curl -s "${D[@]}" "$API/debug/usage?days=2")
check "the operator sees everyone" "$(echo "$EVERYONE" | j "d['total']['people'] >= 1")" "True"
check "with a total in dollars"    "$(echo "$EVERYONE" | j "d['total']['estUsd'].startswith('\$')")" "True"
check "and no email addresses"     "$(echo "$EVERYONE" | j "'@' not in json.dumps(d)")" "True"
check "the usage reader needs the key" "$(curl -s -o /dev/null -w '%{http_code}' "$API/debug/usage")" "404"

echo
echo "── switching engines ──────────────────────────────"
# The switchboard: GLM then Gemini, no key means an engine doesn't exist, an
# order naming no engine is refused with a reason, an old build's ",workers" is
# dropped quietly, one person can differ from everyone, and a plain account
# can't touch any of it.
ME_ID=$(curl -s "${A[@]}" "$API/me" | j "d['user']['id']")
ENG=$(curl -s "${D[@]}" "$API/debug/engines")
check "the engines are GLM, then Gemini" "$(echo "$ENG" | j "','.join(e['engine'] for e in d['engines'])")" "glm,gemini"
check "GLM has no key here"        "$(echo "$ENG" | j "[e['key'] for e in d['engines'] if e['engine']=='glm'][0]")" "missing"
check "nor Gemini"                 "$(echo "$ENG" | j "[e['key'] for e in d['engines'] if e['engine']=='gemini'][0]")" "missing"
check "so a turn has nothing to try" "$(echo "$ENG" | j "len(d['typedOrder']) + len(d['voiceOrder'])")" "0"
check "an order naming no engine is refused with a reason" \
  "$(curl -s -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"engine_order":"claude,workers"}' | j "'names no engine' in d['error']")" "True"
check "Workers AI's model is no longer a setting" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"workers_model":"@cf/openai/gpt-oss-120b"}')" "400"
check "an old build's order loses its Workers AI, quietly" \
  "$(curl -s -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"engine_order":"gemini,glm,workers"}' | j "d['everyone']['engine_order']")" "gemini,glm"
check "without keys the order is still empty" "$(curl -s "${D[@]}" "$API/debug/engines" | j "len(d['typedOrder'])")" "0"
check "Workers AI can't answer spoken turns any more" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d "{\"voice_engine\":\"workers\",\"userId\":\"$ME_ID\"}")" "400"
check "one person can be given their own" \
  "$(curl -s -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d "{\"voice_engine\":\"keyed\",\"userId\":\"$ME_ID\"}" | j "d['mine']['voice_engine']")" "keyed"
check "and everyone else is untouched" "$(curl -s "${D[@]}" "$API/debug/engines" | j "'voice_engine' not in d['everyone']")" "True"
check "a plain account can't see the switchboard" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" "$API/engines")" "403"
check "nor flip it" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$API/engines" -d '{"voice_engine":"keyed"}')" "403"
check "and isn't told it's a developer" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['devTools']")" "False"
curl -s -o /dev/null -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"engine_order":""}'
curl -s -o /dev/null -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d "{\"voice_engine\":\"\",\"userId\":\"$ME_ID\"}"
check "clearing it restores the default" "$(curl -s "${D[@]}" "$API/debug/engines" | j "'engine_order' not in d['everyone']")" "True"
check "the switchboard needs the key" "$(curl -s -o /dev/null -w '%{http_code}' "$API/debug/engines")" "404"

echo
echo "── which voice speaks ─────────────────────────────"
# The voice engine is a setting too. With the phone's own voice the server sends
# no audio and says so; an unknown engine is refused; the account is told which
# engine it has.
check "the usual engine is Deepgram's Aura-2" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['ttsEngine']")" "deepgram-aura-2"
check "a made-up voice engine is refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"tts_engine":"siri"}')" "400"
curl -s -o /dev/null -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d "{\"tts_engine\":\"device\",\"userId\":\"$ME_ID\"}"
check "one person can be given the phone's voice" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['ttsEngine']")" "device"
check "then the server sends no audio, and says why" \
  "$(curl -s -D - -o /dev/null -X POST "${A[@]}" "$API/voice/speak" -d '{"text":"Hello there"}' | tr -d '\r' | awk 'NR==1{printf "%s ", $2} tolower($1)=="x-tts-engine:"{print $2}')" "204 device"
check "everyone else still has Deepgram" "$(curl -s -H "authorization: Bearer $OTHER" "$API/me" | j "d['user']['ttsEngine']")" "deepgram-aura-2"
curl -s -o /dev/null -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d "{\"tts_engine\":\"\",\"userId\":\"$ME_ID\"}"
check "and it can be put back" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['ttsEngine']")" "deepgram-aura-2"
# The Workers AI voices went with Workers AI: choosing one is refused.
check "a Workers AI voice is refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"tts_engine":"workers-aura-2"}')" "400"
# Speech to text is on the phone now (2026-09-23): the server never asks
# Deepgram to listen. Old builds still ask for a clip to be transcribed or a
# live-listening token, and are told plainly to update; the old clip-engine
# switch is gone with them.
check "the clip transcriber switch is gone" \
  "$(curl -s -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/engines" -d '{"stt_clip_engine":"workers-whisper"}' | j "d['error']")" "Nothing to change."
GONE=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: audio/wav' "$API/voice/transcribe" --data-binary 'RIFF....WAVEfmt ')
check "an old build's clip gets 410" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: audio/wav' "$API/voice/transcribe" --data-binary 'RIFF....WAVEfmt ')" "410"
check "with the sentence an old build shows as its error" "$(echo "$GONE" | j "d['error']")" "Update OVOA from TestFlight"
check "and the code alongside" "$(echo "$GONE" | j "d['code']")" "gone"
check "an old build's live-listening token gets 410" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/voice/token?ttl=600")" "410"
check "and the wake word's, the same" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/voice/token?mode=wake")" "410"

echo
echo "── plans: free, base and pro ──────────────────────"
# plans.ts. A local worker has no MEMBERSHIP_API_KEY, so everyone is pro until
# the debug override says otherwise, which is exactly how production behaves
# until the site's key is set. Free gets health, notes and every route that
# never calls a model, and a 402 with a reason on anything that does. Base gets
# every AI feature; Pro is only three times the usage. The day's allowance ends
# in a sentence, not an error, and says when it comes back. The gate in front
# of every model call (modelGate) is shown refusing before any engine is tried:
# with no keys here, a call it lets through says it can't reach the AI instead.
# The "other" account from earlier: it has asked for nothing today, and by now
# sign-ups from this address are over their per-minute limit.
P=(-H "authorization: Bearer $OTHER" -H 'content-type: application/json')
PID=$(curl -s "${P[@]}" "$API/me" | j "d['user']['id']")
setplan() { curl -s -o /dev/null -w '%{http_code}' -X PUT "${D[@]}" -H 'content-type: application/json' "$API/debug/plan" -d "{\"userId\":\"$PID\",\"override\":$1}"; }
# Usage written straight into today's rows (POST /debug/usage): turns, or spend in micro-dollars.
use() { curl -s -o /dev/null -w '%{http_code}' -X POST "${D[@]}" -H 'content-type: application/json' "$API/debug/usage" -d "{\"userId\":\"$PID\",$1}"; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 30 "$@"; }
not402() { [ "$(code "$@")" != 402 ] && echo yes; }
DESIGN='{"description":"A grocery helper that keeps my shopping list"}'
check "no site key: everyone is pro" "$(curl -s "${P[@]}" "$API/me" | j "d['plan']['tier']")" "pro"
check "and /me.plan has the contract's shape" \
  "$(curl -s "${P[@]}" "$API/me" | j "sorted(d['plan'].keys())==['features','limits','renewsAt','status','tier','trialEndsAt'] and sorted(d['plan']['limits'].keys())==['repliesLeftToday','resetsAt'] and sorted(d['plan']['features'].keys())==['agent','chat','voice','wake']")" "True"
check "the override needs the debug key" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' "$API/debug/plan" -d "{\"userId\":\"$PID\",\"override\":\"free\"}")" "404"
check "so does writing usage" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' "$API/debug/usage" -d "{\"userId\":\"$PID\",\"turns\":1}")" "404"
check "a made-up plan is refused" "$(setplan '"gold"')" "400"
check "made free" "$(setplan '"free"')" "200"
FREE_ME=$(curl -s "${P[@]}" "$API/me")
check "free: /me says free" "$(echo "$FREE_ME" | j "d['plan']['tier']")" "free"
check "free: no replies today" "$(echo "$FREE_ME" | j "d['plan']['limits']['repliesLeftToday']")" "0"
check "free: no chat, wake or background work" "$(echo "$FREE_ME" | j "(d['plan']['features']['chat'], d['plan']['features']['wake'], d['plan']['features']['agent'])")" "(False, False, False)"
check "free: /chat is 402" "$(code -X POST "${P[@]}" "$API/chat" -d '{"message":"hello"}')" "402"
NP=$(curl -s -X POST "${P[@]}" "$API/chat" -d '{"message":"hello"}')
check "with error needs_plan" "$(echo "$NP" | j "d['error']")" "needs_plan"
check "needing base" "$(echo "$NP" | j "d['needs']")" "base"
check "and a sentence to show" "$(echo "$NP" | j "d['message'].startswith(\"That's for Base users.\")")" "True"
check "free: voicing is 402" "$(code -X POST "${P[@]}" "$API/voice/speak" -d '{"text":"Hello there"}')" "402"
check "free: an old build's clip hears 410, not 402" "$(code -X POST "${P[@]}" "$API/voice/transcribe" --data-binary 'x')" "410"
check "free: and its token the same" "$(code -X POST "${P[@]}" "$API/voice/token?mode=wake")" "410"
check "free: the brief is 402" "$(code "${P[@]}" "$API/brief")" "402"
check "free: designing an app is 402" "$(code -X POST "${P[@]}" "$API/apps/design" -d "$DESIGN")" "402"
check "free: the setup conversation is 402" "$(code -X POST "${P[@]}" "$API/onboarding/answer" -d '{"step":"name","text":"Sam"}')" "402"
check "free: background work needs base" "$(curl -s -X POST "${P[@]}" "$API/agent/jobs" -d '{"title":"x","instruction":"y","kind":"once"}' | j "d['needs']")" "base"
check "free: heart rate is 200" \
  "$(code -X POST "${P[@]}" "$API/hr" -d "{\"source\":\"band\",\"samples\":[{\"ts\":$(($(date +%s)*1000)),\"bpm\":61}]}")" "200"
check "free: today's heart rate is 200" "$(code "${P[@]}" "$API/hr/today")" "200"
check "free: steps are 200" "$(code "${P[@]}" "$API/steps")" "200"
check "free: a typed note is 201" "$(code -X POST "${P[@]}" "$API/notes" -d '{"text":"Wi-Fi password is on the fridge"}')" "201"
check "free: a note the phone transcribed is 201" \
  "$(code -X POST "${P[@]}" "$API/notes" -d '{"text":"Call the dentist about the crown","source":"on_device"}')" "201"
check "and it says where its words came from" \
  "$(curl -s "${P[@]}" "$API/notes" | j "[n['source'] for n in d['notes'] if 'dentist' in n['text']][0]")" "on_device"
check "a note from nowhere is refused" "$(code -X POST "${P[@]}" "$API/notes" -d '{"text":"x","source":"telepathy"}')" "400"
check "free: notes list is 200" "$(code "${P[@]}" "$API/notes")" "200"
check "free: the home feed is 200" "$(code "${P[@]}" "$API/feed")" "200"
# Everything that never calls a model is free (decision 5).
check "free: routines" "$(code "${P[@]}" "$API/routines")" "200"
check "free: to-dos" "$(code "${P[@]}" "$API/todos")" "200"
check "free: money" "$(code "${P[@]}" "$API/money")" "200"
check "free: alarms" "$(code "${P[@]}" "$API/alarms")" "200"
check "free: people" "$(code "${P[@]}" "$API/people")" "200"
check "free: places" "$(code "${P[@]}" "$API/places")" "200"
check "free: promises" "$(code "${P[@]}" "$API/context/commitments")" "200"
check "free: Google's status" "$(code "${P[@]}" "$API/google/status")" "200"
check "free: the actions waiting for an OK" "$(code "${P[@]}" "$API/actions")" "200"
check "free: reading transcripts" "$(code "${P[@]}" "$API/transcripts/search?q=dentist")" "200"
check "free: making the Siri key" "$(code -X POST "${P[@]}" "$API/siri/key")" "200"
check "but asking through it is 402" "$(code -X POST "${P[@]}" "$API/siri" -d '{"message":"hello"}')" "402"
MADE=$(curl -s -X POST "${P[@]}" "$API/apps" -d '{"name":"Groceries","about":"What I am out of.","icon":"cart-outline","tone":"teal","instructions":"Keep my shopping list."}')
MADE_ID=$(echo "$MADE" | j "d['app']['id']")
check "free: saving an app someone designed" "$([ -n "$MADE_ID" ] && echo yes)" "yes"
check "free: editing it by hand" \
  "$(code -X PUT "${P[@]}" "$API/apps/$MADE_ID" -d '{"name":"Shopping","about":"What I am out of.","icon":"cart-outline","tone":"teal","instructions":"Keep my shopping list."}')" "200"
check "free: old builds' speech routes aren't a plan problem" \
  "$([ "$(code -X POST "${P[@]}" "$API/voice/token")" != 402 ] && [ "$(code -X POST -H "authorization: Bearer $OTHER" -H 'content-type: audio/wav' "$API/voice/transcribe" --data-binary 'RIFF....WAVEfmt ')" != 402 ] && echo yes)" "yes"
check "free: the Calorie screen is 200 (it reads, no model)" "$(code "${P[@]}" "$API/food")" "200"
check "free: deleting history always works" "$(code -X DELETE "${P[@]}" "$API/chat/messages")" "200"
check "free: refreshing the plan works" "$(curl -s -X POST "${P[@]}" "$API/me/plan/refresh" | j "d['plan']['tier']")" "free"

check "made base" "$(setplan '"base"')" "200"
BASE_ME=$(curl -s "${P[@]}" "$API/me")
check "base: 20 replies a day" "$(echo "$BASE_ME" | j "d['plan']['limits']['repliesLeftToday']")" "20"
check "base: every feature, wake word and background work included" "$(echo "$BASE_ME" | j "all(d['plan']['features'].values())")" "True"
check "base: /chat gets past the gate" "$(not402 -X POST "${P[@]}" "$API/chat" -d '{"message":"hello"}')" "yes"
check "base: overheard talk isn't a plan problem" "$(curl -s -X POST "${P[@]}" "$API/chat" -d '{"message":"hello","ambient":true}' | j "d.get('error')!='needs_plan'")" "True"
check "base: background work gets through" "$(code -X POST "${P[@]}" "$API/agent/jobs" -d '{"title":"Check","instruction":"Look.","kind":"once"}')" "201"
check "base: designing an app reaches the engines (none here)" "$(code -X POST "${P[@]}" "$API/apps/design" -d "$DESIGN")" "503"
# The day's spend, used up: $0.30 against Base's $0.25.
check "a day's spend written" "$(use '"microUsd":300000')" "200"
sleep 1
check "base: the spent day leaves no replies" "$(curl -s "${P[@]}" "$API/me" | j "d['plan']['limits']['repliesLeftToday']")" "0"
CAPPED=$(curl -s -X POST "${P[@]}" "$API/chat" -d '{"message":"hello","timeZone":"America/New_York"}')
check "and the next reply says so, plainly" "$(echo "$CAPPED" | j "d['messages'][0]['content'].startswith(\"I've used up today's allowance\")")" "True"
check "with no model asked" "$(echo "$CAPPED" | j "d['meta']['engine']")" "none"
check "and says when it comes back" "$(echo "$CAPPED" | j "'pick up again at' in d['messages'][0]['content']")" "True"
REFUSED=$(curl -s -X POST "${P[@]}" "$API/apps/design" -d "$DESIGN")
check "the gate stops a model route that isn't a reply: 429" "$(code -X POST "${P[@]}" "$API/apps/design" -d "$DESIGN")" "429"
check "keyed on error" "$(echo "$REFUSED" | j "d['error']")" "allowance"
check "before any engine is tried (not 'can't reach the AI')" "$(echo "$REFUSED" | j "d['message'].startswith(\"I've used up today's allowance\") and 'pick up again at' in d['message']")" "True"
check "the setup conversation too" "$(code -X POST "${P[@]}" "$API/onboarding/answer" -d '{"step":"name","text":"Sam"}')" "429"
check "free routes don't care" "$(code "${P[@]}" "$API/routines")" "200"

check "made pro" "$(setplan '"pro"')" "200"
check "pro: the same spend is under Pro's line, so the gate lets it through" "$(code -X POST "${P[@]}" "$API/apps/design" -d "$DESIGN")" "503"
check "pro: /chat gets past the gate" "$(curl -s -X POST "${P[@]}" "$API/chat" -d '{"message":"hello"}' | j "d.get('error')!='needs_plan'")" "True"
check "pro: 60 a day" "$(curl -s "${P[@]}" "$API/me" | j "d['plan']['limits']['repliesLeftToday']")" "60"
check "pro: 1,860 a month" "$(curl -s "${P[@]}" "$API/usage/me" | j "d['cap']['limit']")" "1860"
check "sixty replies written" "$(use '"turns":60')" "200"
sleep 1
CAPPED=$(curl -s -X POST "${P[@]}" "$API/chat" -d '{"message":"hello","timeZone":"America/New_York"}')
check "pro: the 61st reply says the number, and when" \
  "$(echo "$CAPPED" | j "d['messages'][0]['content'].startswith(\"That's all 60 of today's replies on your plan, so I'll pick up again at\")")" "True"
check "with no model asked" "$(echo "$CAPPED" | j "d['meta']['engine']")" "none"
check "but the reply count isn't the gate's: a model call that isn't a reply still goes" "$(code -X POST "${P[@]}" "$API/apps/design" -d "$DESIGN")" "503"
check "the debug view says why" "$(curl -s "${D[@]}" "$API/debug/plan?userId=$PID" | j "d['plan']['from']")" "override"
check "clearing the override" "$(setplan null)" "200"
check "puts them back to what the site (here: no key) says" "$(curl -s "${P[@]}" "$API/me" | j "d['plan']['tier']")" "pro"
curl -s -o /dev/null -X DELETE "${P[@]}" "$API/me"

echo
echo "── 14 days: what's kept, what goes ────────────────"
# retention.ts and daysummary.ts, docs/retention.md. Most of what the purge
# deletes can't be made on a local worker (it takes a model: memories,
# transcript blocks, promises), so rows 20 days old and 2 days old are written
# straight into the local database with wrangler, and the nightly parts are run
# through the debug key. Needs the worker to be `wrangler dev --local` from this
# folder, sharing its .wrangler/state; SKIP_D1=1 skips the section.
if [ "${SKIP_D1:-}" = "1" ]; then
  echo "skipped (SKIP_D1=1)"
else
  ROOT=$(cd "$(dirname "$0")/.." && pwd)
  d1() { (cd "$ROOT" && npx wrangler d1 execute jarvis-db --local --json "$@" 2>/dev/null); }
  KEEP=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
    -d "{\"email\":\"keep$(date +%s)@example.com\",\"password\":\"password123\",\"name\":\"Keep\"}" | j "d['token']")
  ready "$KEEP"
  K=(-H "authorization: Bearer $KEEP" -H 'content-type: application/json')
  KID=$(curl -s "${K[@]}" "$API/me" | j "d['user']['id']")
  curl -s -o /dev/null -X PATCH "${K[@]}" "$API/me" -d '{"contextEnabled":true,"timeZone":"America/New_York"}'
  SEED="$ROOT/.wrangler/retention-seed.sql"
  # Prints the seed, and on its first line the two local days the checks ask
  # about and how many of the routine's events are inside the 14 days.
  node - "$KID" > "$SEED" <<'JS'
const [id] = process.argv.slice(2);
const tz = "America/New_York";
const now = Date.now(), DAY = 86_400_000, OLD = now - 20 * DAY, NEW = now - 2 * DAY;
const dayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const offset = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
};
const atLocal = (day, minutes) => { const w = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000; return w - offset(w - offset(w + 43_200_000)); };
const today = dayOf(now), oldDay = dayOf(OLD), yesterday = addDays(today, -1);
const due = Array.from({ length: 20 }, (_, i) => atLocal(addDays(today, -(i + 1)), 540));
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table, cols, values) => `INSERT INTO ${table} (${cols}) VALUES (${values.map(q).join(", ")});`;
const out = [`-- ${oldDay} ${yesterday} ${due.filter((t) => t >= now - 14 * DAY).length}`];
out.push(row("messages", "id, user_id, role, content, created_at", ["k_m_old", id, "user", "old words", OLD]));
out.push(row("messages", "id, user_id, role, content, created_at", ["k_m_new", id, "user", "new words", NEW]));
for (const [mid, text, source, at] of [["k_mem_asked", "Is vegan.", "asked", OLD], ["k_mem_old", "Likes jazz.", "learned", OLD], ["k_mem_new", "Has a dog.", "learned", NEW]]) {
  out.push(row("memories", "id, user_id, content, source, created_at", [mid, id, text, source, at]));
}
for (const [bid, title, category] of [["k_b_recorded", "Violin lesson", "work"], ["k_b_transcript", "Zebra crossing", "transcript"], ["k_b_promise", "Plumber call", "transcript"]]) {
  out.push(row("context_blocks", "id, user_id, started_at, ended_at, source, title, summary, category, created_at", [bid, id, OLD, OLD, "voice", title, "x", category, OLD]));
}
out.push(row("context_commitments", "id, user_id, block_id, text, status, created_at, due_at", ["k_c_future", id, "k_b_promise", "call the plumber", "open", OLD, now + 5 * DAY]));
out.push(row("context_commitments", "id, user_id, block_id, text, status, created_at, due_at", ["k_c_done", id, "k_b_recorded", "send the deck", "done", OLD, null]));
out.push(row("raw_captures", "id, user_id, ts, text, source", ["k_r_recording", id, OLD, "the violin words", "recording"]));
out.push(row("raw_captures", "id, user_id, ts, text, source", ["k_r_mic", id, OLD, "said to OVOA", "mic"]));
out.push(row("transcript_titles", "user_id, grain, bucket, start, title, summary, updated_at, summarised_at", [id, "day", oldDay, OLD, "Violin and plumbers", "Had a violin lesson.", OLD, OLD]));
out.push(row("transcript_titles", "user_id, grain, bucket, start, title, updated_at", [id, "5m", "k_5m", OLD, "t", OLD]));
out.push(row("objects", "id, user_id, name, location_text, lat, lng, ts", ["k_o_told", id, "passport", "in the safe", null, null, OLD]));
out.push(row("objects", "id, user_id, name, location_text, lat, lng, ts", ["k_o_car", id, "car", "parked", 1, 2, OLD]));
out.push(row("places", "id, user_id, name, kind, lat, lng, created_at", ["k_p_home", id, "Home", "home", 0, 0, OLD]));
out.push(row("places", "id, user_id, name, kind, lat, lng, created_at", ["k_p_unnamed", id, null, "other", 0, 0, OLD]));
// No next_due_at: the cron leaves it alone. Done every day for 20 days.
out.push(row("routines", "id, user_id, kind, title, times, created_at, updated_at", ["k_rt", id, "habit", "Stretch", "[540]", OLD, OLD]));
due.forEach((t, i) => out.push(row("routine_events", "id, routine_id, user_id, due_at, status, created_at", [`k_ev${i}`, "k_rt", id, t, "done", OLD])));
out.push(row("usage_daily", "user_id, day, kind, last_at", [id, new Date(now - 20 * DAY).toISOString().slice(0, 10), "turn", 0]));
out.push(row("usage_daily", "user_id, day, kind, last_at", [id, new Date(now - 40 * DAY).toISOString().slice(0, 10), "turn", 0]));
out.push(`INSERT OR IGNORE INTO profile (user_id, updated_at) VALUES (${q(id)}, ${now});`, `UPDATE profile SET food_detail = 'normal' WHERE user_id = ${q(id)};`);
out.push(row("food_log", "id, user_id, day, ts, name, key, kcal, source, created_at", ["k_f_old", id, oldDay, OLD, "Toast", "toast", 200, "model", OLD]));
const lunch = atLocal(yesterday, 12 * 60);
out.push(row("food_log", "id, user_id, day, ts, name, key, kcal, source, created_at", ["k_f_yesterday", id, yesterday, lunch, "Pasta", "pasta", 650, "model", lunch]));
console.log(out.join("\n"));
JS
  read -r _ OLD_DAY YESTERDAY RECENT_EVENTS < "$SEED"
  check "old and new rows written" "$(d1 --file "$SEED" | j "all(r['success'] for r in d)")" "True"
  STREAK=$(curl -s "${K[@]}" "$API/routines" | j "d['routines'][0]['streak']")
  check "20 days in a row, from 20 days of events" "$STREAK" "20"

  SUMS=$(curl -s -m 120 -X POST "${D[@]}" "$API/debug/agent/tick?what=summaries")
  check "the day summaries run first" "$(echo "$SUMS" | j "'written' in d")" "True"
  check "a day with only food needs no model, and is written" "$(echo "$SUMS" | j "d['written'] >= 1")" "True"
  PURGE=$(curl -s -m 120 -X POST "${D[@]}" "$API/debug/agent/tick?what=retention")
  check "the purge runs, and nothing in it fails" "$(echo "$PURGE" | j "d.get('failed', 0)")" "0"
  # From a file: npx on Windows goes through cmd.exe, which cuts a --command at its first line break.
  cat > "$SEED" <<SQL
SELECT
  (SELECT group_concat(id) FROM (SELECT id FROM messages WHERE id LIKE 'k_m_%' ORDER BY id)) AS messages,
  (SELECT group_concat(id) FROM (SELECT id FROM context_blocks WHERE id LIKE 'k_b_%' ORDER BY id)) AS blocks,
  (SELECT group_concat(id) FROM (SELECT id FROM context_commitments WHERE id LIKE 'k_c_%' ORDER BY id)) AS promises,
  (SELECT group_concat(id) FROM (SELECT id FROM raw_captures WHERE id LIKE 'k_r_%' ORDER BY id)) AS lines,
  (SELECT group_concat(grain) FROM (SELECT grain FROM transcript_titles WHERE user_id = '$KID' AND bucket IN ('$OLD_DAY', 'k_5m') ORDER BY grain)) AS titles,
  (SELECT group_concat(id) FROM (SELECT id FROM objects WHERE id LIKE 'k_o_%' ORDER BY id)) AS objects,
  (SELECT group_concat(id) FROM (SELECT id FROM places WHERE id LIKE 'k_p_%' ORDER BY id)) AS places,
  (SELECT COUNT(*) FROM routine_events WHERE routine_id = 'k_rt') AS events,
  (SELECT COUNT(*) FROM usage_daily WHERE user_id = '$KID') AS usage,
  (SELECT group_concat(id) FROM (SELECT id FROM food_log WHERE id LIKE 'k_f_%' ORDER BY id)) AS food,
  (SELECT COUNT(*) FROM context_search WHERE context_search MATCH 'zebra') AS zebra,
  (SELECT COUNT(*) FROM context_search WHERE context_search MATCH 'violin') AS violin;
SQL
  LEFT=$(d1 --file "$SEED")
  left() { echo "$LEFT" | j "d[0]['results'][0]['$1']"; }
  check "messages: the old one goes" "$(left messages)" "k_m_new"
  check "timeline: what they recorded stays, the titler's goes, one holding a promise stays" "$(left blocks)" "k_b_promise,k_b_recorded"
  check "promises: one still to come stays, one settled long ago goes" "$(left promises)" "k_c_future"
  check "words: a recording's stay, the rest go" "$(left lines)" "k_r_recording"
  check "titles: the day's summary stays" "$(left titles)" "day"
  check "things: what they told OVOA stays, the parked car goes" "$(left objects)" "k_o_told"
  check "places: Home stays, an unnamed one nobody visits goes" "$(left places)" "k_p_home"
  check "routine events: only the last 14 days" "$(left events)" "$RECENT_EVENTS"
  check "usage: counts are kept 35 days" "$(left usage)" "1"
  check "food: 14 days" "$(left food)" "k_f_yesterday"
  check "the search index lets go of what went" "$(left zebra)" "0"
  check "and still finds what stayed" "$(left violin)" "1"
  check "the streak survives its events" "$(curl -s "${K[@]}" "$API/routines" | j "d['routines'][0]['streak']")" "$STREAK"
  check "memories: the one they asked for, and the recent one" "$(curl -s "${K[@]}" "$API/memories" | j "','.join(m['content'] for m in d['memories'])")" "Is vegan.,Has a dog."
  OLDCTX=$(curl -s "${K[@]}" "$API/context/days/$OLD_DAY?timeZone=America/New_York")
  check "an old day is titled by its summary" "$(echo "$OLDCTX" | j "d['title']")" "Violin and plumbers"
  check "with what they recorded still there" "$(echo "$OLDCTX" | j "len(d['blocks'])")" "2"
  YCTX=$(curl -s "${K[@]}" "$API/context/days/$YESTERDAY?timeZone=America/New_York")
  check "yesterday's summary has the day's food, with the number" "$(echo "$YCTX" | j "d['summary']")" "Ate 650 kcal: Pasta."
  check "a second purge finds nothing more" "$(curl -s -m 120 -X POST "${D[@]}" "$API/debug/agent/tick?what=retention" | j "sorted(k for k in d if k != 'ms')")" "[]"
  rm -f "$SEED"
  curl -s -o /dev/null -X DELETE "${K[@]}" "$API/me"
fi

echo
echo "───────────────────────────────────────────────────"
echo "$pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
