# Food: noted by talking, and the Calorie add-on

## What v1 is (2026-09-23)

This is what the code does. The v1 release (`docs/release-v1-prompt.md` Phase 8, and the decisions made with it)
built a smaller version of the first design further down, which is kept for its reasoning. Where the two disagree,
this section and the Decisions at the bottom win.

- **Food memory is on for everyone on Base, at quick**, with nothing to install. Someone says "I had a burrito" in
  passing and OVOA notes it: it never asks. With nothing set up (`profile.food_detail` is NULL, which acts as
  quick) it's also quiet: it doesn't say it logged anything, gives no number unless asked, and replies as it
  normally would.
- **Calorie is the screen plus the tracking level.** The "by OVOA" add-on shows the food and sets how closely OVOA
  asks. Installing it sets `food_detail` to `normal` (or the last level they chose); removing it clears it and
  remembers the choice in `food_detail_last`. Its first open asks "Do you want a rough idea, or should I ask
  what's in things?" with two buttons ("A rough idea" = quick, "Ask what's in things" = normal; strict only by
  voice, "be more exact"). An eating goal in setup, a goal said by voice ("keep me to 2,000") or "be more exact"
  sets the level too (`food_target`, `setFoodLevel`), and the app then installs Calorie itself. No extra made app.
- **Levels:** quick never asks and says "about 900"; normal asks one question when the answer moves the number a
  lot and says "about"; strict asks for the details and says the plain number ("roughly" if the estimate was
  clamped). "Just log it" ends the questions. On screen every number is plain.
- **A food day starts at local midnight**, like every other day in OVOA. There's no wake-to-wake day.
- **Server:** `migrations/0040_food.sql` (`food_log`, `food_catalog`, and four `profile` columns: `food_detail`,
  `food_detail_last`, `kcal_target`, `protein_target`; no dishes, no `food_days`, no `health_id`) and
  `api/src/food.ts`. Tools: `food_log` and `food_amend` are in the core lists (`toolbelt.ts` `SPOKEN_CORE` and
  `TYPED_CORE`), so they and the food guide ride on every turn, spoken and typed, because "I had a burrito"
  names no tool; `food_target` (goal and level) and `food_today` are a `more_tools` away, and the synonyms
  (ate, eat, meal, calories) point at them. The same food logged twice inside 20 minutes is one entry.
- **Clamp:** wider bounds than the table below, and out-of-bounds goes to the nearest bound, not the midpoint.
- **Under-eating:** at most once a week (`daily_marks`), said the next time they talk, when the last seven days
  are clearly lower (under 75%) than their own usual (the days before that): "That's lower than usual, did I
  miss anything?" Only for someone with a level set. No numbers, no advice.
- **Retention:** 14 days for `food_log`; catalog rows go once unused for 14 days. The day's food lives on in the
  day summary (`foodDayLine`), with a number only for someone who set up tracking (`docs/retention.md`).
- **Screen only:** the Calorie add-on (`app/src/app/(tabs)/calorie.tsx`, with `app/src/lib/food.ts`): today's
  ring (eaten against the target when there is one, otherwise just eaten), protein, the entries with a sheet to
  fix one, the last 14 days, the most-eaten foods and the protein average. No feed card, no offline queue, no
  Apple Health writes. Its routes (`/food`, `/food/settings`, `/food/log/:id`) call no model and are free;
  noting food is part of a turn, which is Base.
- **Not in v1:** dishes and servings, missed-meal nudges, the wind-down line, the brief and weekly-report lines,
  body measurements and a computed target (a target is only a number they state), Health active-energy credit,
  Health write-back, photos, the offline queue.

---

The first design, kept for the reasoning. It planned food as an add-on you install before anything is noted,
with its own feed card; v1 turned that round (above). The user's decisions at the bottom override it where they
differ.
Server = `jarvis/api` (Worker + D1). App = `jarvis/app` (Expo).
Reuses: `capabilities()` (`api/src/capabilities.ts`), the assistant tool pattern (`api/src/notes.ts` is the
closest model), `profile` (0017), `daily_marks` (0019), HealthKit (`app/src/lib/health.ts`),
`sendBuzz`/`push`, the morning brief and wind-down ticks (`api/src/rhythm.ts`).

## The pitch

Every calorie app is a search box. You eat a thing, then you go hunting for it in a database, then you
argue with the serving size. OVOA already has a microphone on the user's chest and a model that knows
what a chicken thigh weighs. So the interaction is:

> "I'm making chicken for two, about a pound, with a tablespoon of olive oil and some rice."
> — *"Got it. Chicken and rice, two servings, about 640 each. Say 'I had a plate' when you eat."*

> "I had a plate."
> — *"Logged, 640. You're at 1,480 for the day, about 700 left."*

No search, no barcode, no serving-size dropdown. The whole feature is one voice turn plus a number the
user can ask for.

## What makes it hard (and what we do about it)

| Problem | What OVOA does |
|---|---|
| Same meal logged twice gives two different numbers, so the totals feel fake | Every food the model estimates is written to a **catalog** keyed by a normalized name. Second time round, the catalog answers — the model doesn't re-guess. |
| "Making" is not "eating" | Two states. `cooked` creates a **dish** with servings and logs nothing. `eaten` logs. A plate of a known dish is one serving of it. |
| Models happily say 40 kcal for a tablespoon of oil | Server-side **sanity clamp** against a small hardcoded table of density bounds (kcal/g by category). Anything outside it is recomputed from grams × a category default, and the entry is flagged `estimated: "clamped"`. |
| Questions kill the feature for a casual user; guesses kill it for a serious one | It depends on the user's **tracking level** (below). A casual user is never asked; a serious one is asked what kind, where from and what's in it. Whatever it doesn't ask, it assumes and *says out loud* so they can correct it. |
| The user corrects after the fact | `food_amend` edits the last entry (or a named one) in place: "make that two tablespoons", "that was a small one", "I didn't finish it". |
| Extra latency for a lookup | **None.** The model fills in grams and kcal as tool arguments in the same turn it's already taking. No food-database round trip, no second model call. |

## How closely: it depends on how serious the user is

"I had a burrito" is worth three questions to someone cutting weight for a meet and none to someone who
wants a rough idea. So the add-on has a **tracking level**, `profile.food_detail`:

| Level | "I had a burrito" | Rule |
|---|---|---|
| `quick` | *"Logged a chicken burrito, about 900. Tell me if it was different."* | Never asks. Best guess, and says what it assumed. |
| `normal` (default) | *"What kind of burrito?"* → "steak" → *"Logged, about 950."* | One question, only when the answer moves the number by more than 25%. |
| `strict` | *"What kind, and was it from somewhere like Chipotle or homemade? Rice, cheese, sour cream, guac?"* | Asks what it needs for a tight number: what kind, where from (chains publish their numbers), size, and the extras that swing it. Asks them together in one sentence, not one at a time, and at most two rounds. Logs protein, carbs and fat. |

- **Picked** when the add-on is first opened (*"Do you want a rough idea, or should I ask what's in
  things?"*), or during the setup conversation when a health goal makes it obvious (cutting for a show →
  `strict`, "eat a bit better" → `quick`).
- **Changed by voice** any time: "stop asking, just log it" → `quick`, "be more exact" → `strict`.
  "Just log it" also ends the current questions at any level, and it logs its best guess.
- `food_target` takes `detail` to save it; the prompt section reads it. A goal said by voice ("keep me to
  2,000") with no level set turns Calorie on at the level they chose before, or `normal`, as an eating goal in
  setup does.
- **Nothing set up** (`food_detail` NULL: everyone on Base who hasn't installed Calorie) acts as `quick`, and
  quietly: noted without a word, and no number unless they ask.

## Standalone rule

| Needs | Improves it | Without the optional parts |
|---|---|---|
| app (voice or text) | Health (active energy → "calories left"), band (hands-free while cooking), profile (weight/height/age/sex → target) | Logs and totals still work; the target falls back to a flat number the user states ("keep me to 2,000"), and "left" is target − eaten with no burn credit. |

Everything here works with no Google, no watch, no band, no HealthKit. That matches the zero-setup rule.

---

## Tables (the first design)

v1's tables are `migrations/0040_food.sql`: `food_log` and `food_catalog` (per 100 g, with `used_at` for the
14-day purge) and four `profile` columns. No `food_dishes`, no `food_days` (a day's total is summed from
`food_log`), no `health_id`, and no body measurements. The first design follows.

```sql
-- Eating, tracked by talking about it.
--
-- Three tables for three different lifetimes. A catalog row is a fact about a
-- food and is kept forever, so the same meal costs the same number every time.
-- A log row is one thing eaten and is detailed; it's thinned after 90 days.
-- A day row is the total and is never thinned, because a year of daily totals is
-- the only part anyone looks back at.

-- What a food costs, per 100 g, learned once.
-- `key` is the name lowercased, stripped to letters and single spaces, so
-- "Olive Oil" and "olive oil " are one row. `source`: model | user | health.
CREATE TABLE food_catalog (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  kcal_100g  REAL NOT NULL,
  protein_g  REAL,
  carbs_g    REAL,
  fat_g      REAL,
  -- fat | grain | protein | veg | fruit | dairy | drink | sweet | mixed —
  -- picks the clamp bounds below.
  category   TEXT NOT NULL,
  -- A typical single portion in grams, so "a plate of rice" has a default.
  serving_g  REAL,
  source     TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- A dish cooked but not yet eaten: a pot of chili, a tray of chicken.
-- Eating "a plate" of it draws down `servings_left`.
CREATE TABLE food_dishes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- JSON: the ingredients as logged, for "what's in it?" and for re-costing.
  items         TEXT NOT NULL,
  kcal_total    REAL NOT NULL,
  protein_g     REAL,
  carbs_g       REAL,
  fat_g         REAL,
  servings      REAL NOT NULL,
  servings_left REAL NOT NULL,
  cooked_at     INTEGER NOT NULL
);
CREATE INDEX food_dishes_open ON food_dishes (user_id, servings_left, cooked_at);

-- One thing eaten.
CREATE TABLE food_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The user's local day, so a 1 a.m. snack lands where they'd put it (see below).
  day        TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  name       TEXT NOT NULL,
  grams      REAL,
  kcal       REAL NOT NULL,
  protein_g  REAL,
  carbs_g    REAL,
  fat_g      REAL,
  -- breakfast | lunch | dinner | snack — from the clock, overridable.
  meal       TEXT,
  -- catalog | model | dish | user | health
  source     TEXT NOT NULL,
  dish_id    TEXT REFERENCES food_dishes(id) ON DELETE SET NULL,
  -- ok | clamped | assumed_portion — surfaced as "roughly" in speech.
  estimated  TEXT,
  -- What OVOA assumed, in words, so an amend knows what it's correcting.
  assumption TEXT,
  -- Set when it's been written to Apple Health, so it isn't written twice.
  health_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX food_log_day ON food_log (user_id, day, ts);

-- The day's totals, rebuilt on every write. Cheap, and it makes every read
-- ("how am I doing", the brief, the weekly report) a single-row lookup.
CREATE TABLE food_days (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  kcal       REAL NOT NULL DEFAULT 0,
  protein_g  REAL NOT NULL DEFAULT 0,
  carbs_g    REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  entries    INTEGER NOT NULL DEFAULT 0,
  -- The target in force that day, copied in so history doesn't move when the
  -- goal changes.
  target     REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- The numbers behind the target. On `profile` rather than a table of its own:
-- they're the same kind of fact as wake_time.
ALTER TABLE profile ADD COLUMN weight_kg     REAL;
ALTER TABLE profile ADD COLUMN height_cm     REAL;
ALTER TABLE profile ADD COLUMN birth_year    INTEGER;
ALTER TABLE profile ADD COLUMN sex           TEXT;   -- male | female | null
ALTER TABLE profile ADD COLUMN activity      TEXT;   -- sedentary | light | moderate | active
ALTER TABLE profile ADD COLUMN goal          TEXT;   -- lose | maintain | gain
ALTER TABLE profile ADD COLUMN kcal_target   REAL;   -- stated outright, wins over the computed one
ALTER TABLE profile ADD COLUMN protein_target REAL;
```

**Day boundary: local midnight** (decision 8 below). The first design ran a day from wake to wake, so a 1 a.m.
snack counted as last night's. v1 doesn't: a food day starts at local midnight, like every other day in OVOA
(the day summary, the timeline, the allowance), so the Calorie screen, the day summary and "what did I eat
today" never disagree about which day a meal was.

---

## Server — `api/src/food.ts`

### The estimate path

1. The model calls `food_log` with items it has already priced: `{name, grams, kcal, protein, carbs, fat, category}`.
2. For each item, `key = normalize(name)`. If the catalog has it **and** the model's kcal/100g is within
   ±30% of the stored value, the catalog wins (consistency beats freshness); a number they corrected wins from
   half to double it. Outside that band, the model
   is probably talking about a different food with the same name — keep both by qualifying the key with
   what the model said (`"chicken thigh skin on"`).
3. Clamp: `kcal/100g` must sit inside the category's bounds.

   ```ts
   /** kcal per 100 g, low/high, per category. A model that says a tablespoon of
    *  oil is 40 kcal is corrected, not believed. */
   const BOUNDS = {
     fat:     [700, 900],  grain: [100, 400],  protein: [80, 350],
     veg:     [10, 120],   fruit: [25, 150],   dairy:   [30, 450],
     drink:   [0, 250],    sweet: [250, 600],  mixed:   [40, 400],
   };
   ```
   Out of bounds → recompute from the category midpoint, set `estimated = "clamped"`.
4. Write the log rows, upsert the catalog, rebuild `food_days`, `logAction(… "food" …)`.
5. Return the day's running total and what's left, so the model's spoken reply is one sentence with a
   real number in it — never "logged!" with nothing after it.

### The target

```ts
/** Mifflin-St Jeor, then activity, then the goal. Returns null when the profile
 *  is too thin to compute one — the caller then asks, once, or does without. */
export function dailyTarget(p: Profile): number | null
```
- BMR = `10·kg + 6.25·cm − 5·age + (sex === "male" ? 5 : −161)`; no sex on file → the mean of the two.
- × activity (1.2 / 1.375 / 1.55 / 1.725).
- goal `lose` → −500 (floored at 1,200 / 1,500 by sex), `gain` → +350.
- `profile.kcal_target`, if the user just said a number, beats all of it.
- Protein target: `1.6 g/kg` when lifting is in the picture, else `1.2 g/kg`.

### "Calories left"

`target − eaten + burnCredit`, where `burnCredit` is **only** the Health *active* energy for the day
(never steps×factor on top of it — that's the classic double-count), and 0 when `caps.health` is false.
Spoken as a range when the day is young ("about 900 left") and a number when it isn't.

### Ticks (folded into the existing rhythm cron, no new schedule)

None of these ship in v1. Outside a turn, food only shows up in the day summary's food line and in the
under-eating check, which is said the next time they talk; the nightly purge deletes at 14 days
(`retention.ts`), not 90, and keeps no totals.

| When | What |
|---|---|
| A meal window passes with nothing logged (>3 h after the usual time, learned from `food_log` history the way `expectations` are learned) | One nudge, at most twice a day: buzz + "Did you eat?" — and only after 5 days of history, so it never nags a new user. |
| Wind-down | Adds one line to the existing recap: total, protein, whether they're over. |
| Morning brief | Yesterday's total, but only when it was unusual (>15% off target). Nobody wants the number read to them every day. |
| Weekly report (F28) | Daily average, protein average, the days they were over, the three foods they ate most. |
| Nightly | Thin `food_log` rows older than 90 days (`food_days` stays). Catalog is kept. |

### Apple Health

Not in v1: OVOA doesn't write to Apple Health (`NSHealthUpdateUsageDescription` says so), so there's no
`health_id`. The first design:

When `caps.health`, the app writes each entry as `HKQuantityTypeIdentifierDietaryEnergyConsumed` (plus
protein/carbs/fat) and reports back the sample id into `health_id`. Needs a HealthKit **write** scope,
which `health.ts` doesn't request today — it's a one-line addition to a new `WRITE` list, and it's
optional: refusing the permission costs nothing but the mirror.

---

## Tools

Follows `notesAssistant`: `TOOLS`, `NAMES`, `isFoodTool`, `foodAssistant(env, userId, timeZone, {voice, level})`,
wired into `runTurn` in `index.ts` like every other tool set (the tool list, the guides, the toolbelt, the
`["food", …]` section and the dispatch). In v1 `food_log` and `food_amend` are also in the **core lists**
(`toolbelt.ts` `SPOKEN_CORE` and `TYPED_CORE`): "I had a burrito" names no tool, so only a core tool, and the
food guide that comes with it, is there when it's said. v1 ships four of the five below: no `food_eat_dish`, and
`food_target` takes only a stated `kcal`, `protein` and `detail` (no body measurements).

```ts
const TOOLS: ToolSpec[] = [
  {
    name: "food_log",
    description:
      "Records what they ate or cooked, when they say it in passing: 'I had a bowl of oatmeal', 'making chicken with a tablespoon of oil', 'just had a coffee with milk'. YOU supply the grams and the calories — you know what food weighs, so don't ask them to look anything up. Use state 'cooked' when they're making it and haven't eaten yet; 'eaten' when they've had it. Ask only as much as their tracking level allows (see the food section); anything you don't ask about, assume an ordinary version and say what you assumed.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The food, plainly: 'olive oil', 'chicken thigh', 'white rice, cooked'." },
              grams: { type: "number", description: "Your best estimate of the weight eaten, in grams." },
              kcal: { type: "number", description: "Calories for that weight." },
              protein: { type: "number" }, carbs: { type: "number" }, fat: { type: "number" },
              category: { type: "string", enum: ["fat","grain","protein","veg","fruit","dairy","drink","sweet","mixed"] },
            },
            required: ["name", "grams", "kcal", "category"],
          },
        },
        state: { type: "string", enum: ["eaten", "cooked"], description: "Default eaten." },
        dishName: { type: "string", description: "What the cooked thing is called, when state is cooked." },
        servings: { type: "number", description: "How many portions it makes, when state is cooked." },
        meal: { type: "string", enum: ["breakfast","lunch","dinner","snack"], description: "Only if the clock would get it wrong." },
        assumed: { type: "string", description: "What you assumed about the portion, in a few words: 'a cup of rice', 'a medium banana'." },
        at: { type: "string", description: "Local YYYY-MM-DDTHH:MM, if it wasn't just now ('I had a sandwich at noon')." },
      },
      required: ["items"],
    },
  },
  {
    name: "food_eat_dish",
    description: "They're eating something they already told you they cooked: 'I had a plate of that chili', 'another bowl'. Draws down the servings left.",
    parameters: { type: "object", properties: { dish: { type: "string" }, servings: { type: "number", description: "Default 1. Half a plate is 0.5." } } },
  },
  {
    name: "food_amend",
    description: "Corrects what was just logged: 'make that two tablespoons', 'I only ate half', 'that wasn't me', 'it was the large one'. Defaults to the last entry.",
    parameters: {
      type: "object",
      properties: {
        which: { type: "string", description: "Words from the entry, if it isn't the last one." },
        fraction: { type: "number", description: "They ate this much of what was logged: 0.5 for half, 0 to remove it." },
        grams: { type: "number", description: "The corrected weight, if they gave one." },
        kcal: { type: "number", description: "The corrected calories, if you're re-estimating." },
      },
    },
  },
  {
    name: "food_today",
    description: "How they're doing today: eaten, left, protein, and what they've had. For 'how many calories have I had', 'what's left', 'what did I eat today'. Also takes a past day.",
    parameters: { type: "object", properties: { day: { type: "string", description: "Local YYYY-MM-DD, default today." } } },
  },
  {
    name: "food_target",
    description: "Sets or changes the goal: 'keep me under 2000', 'I want to lose a bit', 'I'm 82 kilos'. Saves whichever of weight, height, age, sex, activity and goal they mentioned, and works out the target from them.",
    parameters: {
      type: "object",
      properties: {
        kcal: { type: "number" }, protein: { type: "number" },
        weightKg: { type: "number" }, heightCm: { type: "number" }, age: { type: "number" },
        sex: { type: "string", enum: ["male","female"] },
        activity: { type: "string", enum: ["sedentary","light","moderate","active"] },
        goal: { type: "string", enum: ["lose","maintain","gain"] },
        detail: { type: "string", enum: ["quick","normal","strict"], description: "How closely they want it tracked: 'just log it, stop asking' is quick, 'be more exact' is strict." },
      },
    },
  },
];
```

**Prompt section** (the `["food", …]` entry):

> When they mention eating or cooking anything at all, log it with food_log without being asked to —
> "grabbed a bagel" is a log, not small talk. Estimate the weight and calories yourself; never ask them
> to weigh or look something up. Their tracking level is {detail}: quick means never ask; normal means
> one question, only when the answer would change the number a lot ("what kind of burrito?"); strict
> means ask what kind, where it's from, the size and what's in it, all in one sentence, then log. If they
> say "just log it", stop asking and log your best guess. Say the total afterwards in one short sentence with the number in it, and name what you
> assumed so they can correct you. "Making" is not "eating": use state cooked, and log it properly when
> they say they've had some.

**Voice filter.** All five stay in a spoken turn — this is a voice-first feature. `food_today` returns at
most the last 6 items when `voice`, since the rest can't be heard anyway.

---

## App: the Calorie screen

v1 is a screen only: the Calorie add-on (`app/src/app/(tabs)/calorie.tsx`, `app/src/lib/food.ts` for its routes
and for installing it when the server says a level is set). There is no feed card, no HealthKit mirror and no
offline queue; food is noted from a turn, so it goes wherever the turn goes.

- **No new capture path.** A Band click already opens a turn (the phone's ear hears it; `liveListen.ts`),
  which is exactly what you want with raw chicken on your hands.
- Today is a ring (eaten against the target, or just eaten when there's no target), a protein bar, and
  today's entries as rows. Tapping a row opens a sheet with a grams stepper, the one place where touching
  beats talking, because "make it 140 grams" is fiddly by voice. Under it: the last 14 days, the most-eaten
  foods and the protein average.
- Not built: `writeDietaryEnergy` (the HealthKit mirror and its `health_id` backfill), the feed card, and an
  offline queue in `storage.ts`.

---

## Phases

The first design's plan. v1 shipped phase 1 without the wind-down line or a stored day rollup, plus a stated
target (no Mifflin-St Jeor, no burn credit) and the Calorie screen in place of the feed card; the top of this file
has the list.

| Phase | What ships | Why here |
|---|---|---|
| **1** | migration, `food.ts`, `food_log` / `food_today` / `food_amend`, catalog + clamp, day rollup, one line in the wind-down | This alone is the whole pitch. Usable on day one with no profile, no Health, no band. |
| **2** | `food_target` + Mifflin-St Jeor, "calories left", Health active-energy credit, the feed card | Turns a log into a number that means something. |
| **3** | dishes (`food_eat_dish`), missed-meal nudge, brief + weekly report lines | The cooking flow and the habit loop. |
| **4** | Health write-back, photo logging (camera → vision model → the same `food_log` arguments), restaurant-menu lookup via `web.ts` | Nice; none of it is load-bearing. |

## What Cal AI does, and what we take from it

Cal AI is the app that defined this category: built by two teenagers in 2024, ~5M users, $30M revenue in
2025, sold to MyFitnessPal in early 2026. Worth copying deliberately, and worth *not* copying in one
specific place.

**Their pipeline.** Photo → the phone's depth sensor estimates food volume → image models from Anthropic
and OpenAI, several of them, because "different models are better with different foods" → RAG over food
calorie/image databases (open-source sets off GitHub) → calories and macros in a few seconds. They
fine-tuned on top of that. The app also takes barcodes, nutrition labels, and a typed description.

**The number that should change our plan: only ~30% of their logs are photos.** The rest are barcodes and
manual/described entry. Their flagship feature is the marketing, not the workhorse. A voice-first logger
is not a compromised version of Cal AI — it's aimed at the 70%.

**The accuracy reality.** A controlled study (102 meals from a metabolic kitchen, presented at NUTRITION
2026, abstract not yet peer-reviewed) ran MyFitnessPal, Lose It!, Appediet and Cal AI against the true
values. Every app underestimated, by about a third:

| App | Energy underestimated by |
|---|---|
| Appediet | 252 kcal |
| MyFitnessPal | 327 kcal |
| Lose It! | 333 kcal |
| **Cal AI** | **345 kcal** |

All four missed **~30 g of fat per meal**. That's the whole story: fat is 9 kcal/g and *invisible in a
photograph* — the oil in the pan, the butter on the pan-fried fish, the dressing, the marbling in the cut.
A camera cannot see what a cook knows. Cal AI's own site says "about 80% accurate"; their marketing says
90%+; the controlled test says ~67%.

**So the design above is pointed at exactly their weak spot.** "Making chicken with a tablespoon of olive
oil" *states the fat*. No depth sensor can recover that number, and the user hands it over for free
because they're the one holding the bottle. Two concrete consequences for our spec:

- The `fat` category clamp (700–900 kcal/100g) isn't paranoia about the model — it's guarding the single
  variable the whole category gets wrong. Keep it.
- The prompt should actively ask about cooking fat when a cooked dish is logged without any: *"any oil or
  butter?"* is the one clarifying question worth the user's patience, because it's worth ~200 kcal.
  This is the exception to the one-question rule, and it should be the question we spend it on.

**Worth stealing from their product:**
- **Photo as a *supplement*, not the spine** — our phase 4 placement is right, and it should route into
  the same `food_log` arguments rather than becoming a second system.
- **Barcode scanning** is cheap, boring, and more accurate than any AI path. If phase 4 ships anything,
  ship this before photos.
- **A stated accuracy number in the UI.** They say "about 80%" out loud and it defuses complaints. We
  should say something equally plain rather than implying precision we don't have.
- **Mixed dishes are where everything fails** (errors 50–70% worse than single plates). Our dish/servings
  model helps here for once: a pot of chili priced from stated ingredients and divided by 6 beats
  photographing a bowl of it.

**Worth not stealing:** the 32-screen onboarding with a hidden price and a mid-flow rating prompt. It's
well-optimised funnel design for a standalone $30/yr app, and it's the wrong shape for a feature inside an
assistant the user already set up. Our onboarding is one sentence: *"How many calories do you want to
stay under?"* — or nothing at all, because phase 1 works with no target.

> Source note: the accuracy figures above come from the NUTRITION 2026 abstract and TechCrunch. Most other
> "AI calorie app accuracy" results on the web are content marketing published by competing apps — one
> such benchmark claims ±1.1% for its own product, which is not a believable number for photo estimation.
> Treat anything not from the study or the founders' own statements as advertising.

## Decisions (user, 2026-09-23)

These override the spec above where they differ.

1. **Food memory for everyone on Base; Calorie is the screen and the tracking level.** OVOA notes food
   whenever it's mentioned, for everyone on Base, with nothing to install, at `quick` (never asks), and
   quietly while nothing is set up. The model judges the calories from what they say: Cal AI, but by talking
   instead of photos. The "by OVOA" **Calorie** add-on in Apps is the screen that shows it, plus the tracking
   level: installing it turns the level on (`normal` by default), removing it turns it off and remembers the
   choice. The screen's reads and fixes call no model and are free; noting food is part of a turn, which is
   Base.
2. **Retention: 14 days.** Everything except the day summary is deleted after 14 days. That replaces the
   90-day log, forever totals and forever catalog above: `food_log` rows go at 14 days, catalog rows once
   unused for 14 days, and there are no stored day totals. The day's food lives on in the day summary.
3. **How closely depends on the user.** OVOA asks what kind of burrito when the user is serious about
   tracking, and doesn't when they aren't. See "How closely" near the top.
4. **Under-eating: yes.** At most once a week, said the next time they talk, when the last week is clearly
   lower than their own usual: "that's lower than usual, did I miss anything?" It never comments on the
   number. (This replaces the first idea of a fixed "under ~1,000 kcal more than twice in a week".)
5. **No controversy.** No streaks, no praise for being under, no red numbers for going over, no
   moralizing, and it never brings up eating disorders.
6. **Setup builds the goal app.** The setup conversation asks about fitness or health goals and habits
   and makes an app for each. When the goal is about eating, it installs Calorie and sets the tracking
   level instead, with no extra made app.
7. **How the number is said.** "About" at `quick` and `normal`; the plain number at `strict`, after it
   has asked, and "roughly" there when the estimate had to be clamped. With nothing set up, no number
   unless they ask. On screen every number is plain.
8. **A food day starts at local midnight**, like the rest of OVOA.
9. **Screen only.** The Calorie screen replaces the feed card. No offline queue, no Apple Health writes
   (no `health_id`), no photos, no dishes, no missed-meal nudges, no wind-down line, and no food in the
   morning brief or weekly report in v1.
