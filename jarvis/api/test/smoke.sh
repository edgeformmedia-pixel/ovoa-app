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

echo "── signup ─────────────────────────────────────────"
TOKEN=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"name\":\"Smoke\"}" | j "d['token']")
[ -n "$TOKEN" ] && { echo "ok   got a token"; pass=$((pass+1)); } || { echo "FAIL no token"; exit 1; }
A=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

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
check "nine questions"           "$(echo "$ONB" | j "d['total']")" "9"
check "skipping moves on"        "$(curl -s -X POST "${A[@]}" "$API/onboarding/skip" -d '{"step":"name"}' | j "d['next']['step']")" "nicknames"
check "an empty answer is refused"   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/onboarding/answer" -d '{"step":"nicknames","text":" "}')" "400"
for s in nicknames wake_sleep work meds pets gym routines; do curl -s -o /dev/null -X POST "${A[@]}" "$API/onboarding/skip" -d "{\"step\":\"$s\"}"; done
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
check "Claude without a key says so" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$API/claude" -d '{"prompt":"hi"}')" "503"

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
# proving, because it is the case that used to leave no trace at all.
curl -s -m 60 -o /dev/null -X POST "${A[@]}" "$API/chat" -d '{"message":"hello","timeZone":"America/New_York"}'
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
EVERYONE=$(curl -s "${D[@]}" "$API/debug/usage?days=2")
check "the operator sees everyone" "$(echo "$EVERYONE" | j "d['total']['people'] >= 1")" "True"
check "with a total in dollars"    "$(echo "$EVERYONE" | j "d['total']['estUsd'].startswith('\$')")" "True"
check "and no email addresses"     "$(echo "$EVERYONE" | j "'@' not in json.dumps(d)")" "True"
check "the usage reader needs the key" "$(curl -s -o /dev/null -w '%{http_code}' "$API/debug/usage")" "404"

echo
echo "───────────────────────────────────────────────────"
echo "$pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
