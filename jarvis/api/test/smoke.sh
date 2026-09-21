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
echo "── capture everything is dev-only ─────────────────"
check "refused for an ordinary account"   "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${A[@]}" "$API/me" -d '{"captureEverything":true}')" "403"
check "still off" "$(curl -s "${A[@]}" "$API/me" | j "d['user']['settings']['captureEverything']")" "False"
check "turning it off is always allowed"   "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${A[@]}" "$API/me" -d '{"captureEverything":false}')" "200"

echo
echo "───────────────────────────────────────────────────"
echo "$pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
