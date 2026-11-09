# Lift & Intake

A workout and nutrition logger that runs on your iPhone as a Home Screen app.
No account, no server, no subscription. Everything lives on the phone.

Built as a Progressive Web App, which is why it installs without Apple's
signing bureaucracy: iOS will not let you sideload a native app without a
certificate Apple issued, but it will happily let a web app claim a Home Screen
icon and run full screen with no browser chrome.

---

## Getting it onto your phone

There are two steps: put the files on the internet over HTTPS, then add the
page to your Home Screen. The HTTPS part is not optional. Service workers, which
are what make the app work offline, are blocked on plain HTTP.

### 1. Host it (GitHub Pages, free)

1. Make a new repository on GitHub. Public is fine, and it keeps Pages free.
2. Upload everything in this folder to the root of the repo. Drag and drop
   works: `github.com/<you>/<repo>` → **Add file** → **Upload files**.
3. Create a file named `.nojekyll` in the repo root: **Add file** → **Create new
   file**, type `.nojekyll` as the name, leave it empty, commit. Your computer
   probably hides dotfiles, so this is more reliable than dragging it in.
   See "Why `.nojekyll`" below for what it does.
4. Go to **Settings** → **Pages**.
5. Under *Source*, pick **Deploy from a branch**, branch `main`, folder `/ (root)`.
6. Wait about a minute. Your URL will be `https://<you>.github.io/<repo>/`.

#### Why `.nojekyll`

GitHub Pages runs every repo through Jekyll, a blog engine, before serving it.
Jekyll's default configuration silently **excludes a folder named `vendor`**,
along with `node_modules`. If your app has one, those files 404 in production
while working perfectly on your machine, and nothing tells you: you just get a
blank screen.

This project keeps its one dependency in `lib/` rather than `vendor/` so it
survives even without the file, but `.nojekyll` turns the whole layer off and
removes the class of bug entirely. Worth doing on any static site you host here.

### 2. Install it on the iPhone

1. Open that URL **in Safari**. Not Chrome, not the in-app browser in a
   messaging app. Only Safari can add a web app to the Home Screen on iOS.
2. Tap the Share button (the square with the arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**.

You now have a barbell icon on your Home Screen. Open it. There is no address
bar and no tab strip: it looks and behaves like any other app, and it works with
the phone in airplane mode.

### 3. Do this once, on day one

Open **Settings** inside the app and tap **Export backup**, then save the file
to Files or iCloud Drive. Read the "Where your data lives" section below for why
this matters more than it sounds like it does.

---

## Where your data lives

In IndexedDB, in the browser storage belonging to that Home Screen app, on that
phone. Not in the cloud. Not on any server. Nobody else can see it, including
me, and there is nothing to log into.

The tradeoff is that the phone is a single point of failure:

- **Deleting the Home Screen icon deletes the data.** iOS treats removing an
  installed web app as clearing its storage. There is no undo.
- **Storage is not formally guaranteed.** The app calls
  `navigator.storage.persist()` on every launch, and WebKit grants persistence
  using heuristics that strongly favour installed Home Screen apps. That is a
  good bet, not a contract.
- **Restoring a phone from a backup may or may not carry it over.**

So: export a backup every so often. It is a JSON file with everything in it, and
**Restore from backup** in Settings reads it back. Treat it the way you would
treat a spreadsheet you care about.

---

## Updating the app after you change something

Edit the files, upload them to GitHub, and **bump `CACHE_VERSION` at the top of
`sw.js`**.

That last part is not optional and it is the single most common reason a PWA
"won't update". The service worker caches the app's own files so it can run with
no signal. Until the cache name changes, the phone keeps serving the copy it
already has, forever, no matter how many times you redeploy. Changing
`lift-v4` to `lift-v5` is what tells it to fetch fresh files.

Your logged data is untouched by this. The cache holds about 100KB of code; your
sets and meals are in IndexedDB, which the service worker never looks at.

---

## What's in here

```
index.html            page shell, iOS meta tags, safe-area setup
app.webmanifest       name, icons, standalone display mode
sw.js                 service worker: the offline cache
css/app.css           one stylesheet, dark and light themes
lib/dexie.mjs      IndexedDB wrapper, vendored so it works offline
js/
  app.js              router, tab bar, and the persistent rest-timer bar
  chart.js            inline-SVG line charts, no library
  exercise-form.js    the exercise editor, shared by Library and the workout
  seed.js             the meal prep recipes, preloaded
  db.js               schema, indexes, and every read and write
  ui.js               the whole rendering layer, in about 90 lines
  util.js             dates, formatting, e1RM, BMR
  timer.js            rest timer
  views/
    today.js          the workout screen
    food.js           the nutrition tab
    library.js        exercises, programs, foods
    progress.js       per-exercise weight and reps charts
    settings.js       profile, bodyweight chart, calorie estimate, backup
```

No build step, no `node_modules`, no framework. Edit a file, refresh, see the
change. Every file is plain ES modules that the browser loads directly.

---

## Design decisions worth knowing before you change anything

**History is written once and never rewritten.** When you log a set, the weight
and reps belong to that set permanently. When you log a food, the macros are
*copied onto the log entry* at that moment rather than looked up later. Correct
a food's protein number six months from now and your past days do not silently
change. If you edit a record anyway, it gets an `editedAt` stamp and the UI
marks it, so a corrected row never passes as an original one.

**A library is not a log.** Exercises and foods are defined once and referenced
by id. That is what makes progress charts possible and what stops "Barbel Squat"
from becoming a separate movement forever.

**The rest timer never counts ticks.** iOS suspends JavaScript the moment you
pocket the phone, which is exactly when the timer is running. It stores a start
timestamp and computes `now - start` on every paint, so it is still correct when
the screen comes back on.

**Everything is pounds.** No unit column, no conversion layer. Mixed units in
one column make every sum and chart quietly wrong.

**Every set is a working set.** There is no warmup flag, so volume and personal
record math need no filter. If you start logging warmups, they will count.

**Nothing you can delete orphans your history.** Archiving an exercise hides it
from pickers and keeps your sets. Deleting a program drops the pointer from past
sessions but keeps the day name they were recorded under.

---

## Where the barcode scanner goes when you want it

Scanning is not a new entity and not a new table. `Food` already has `barcode`
(indexed) and `source`, because a scan is just a faster way to fill in the same
form. The path:

1. Read the barcode with a JS decoder such as `zxing-js`. Safari does not
   implement the browser's native `BarcodeDetector`, so a library is required.
2. Look it up in your own `foods` table first (`findFoodByBarcode`, already in
   `db.js`). If you own it, you are done in one seek.
3. On a miss, query [Open Food Facts](https://world.openfoodfacts.org/data).
   Free, open, no API key.
4. Pre-fill the New Food form with `source: 'barcode'` and let a human confirm
   before saving.

Label OCR (`tesseract.js`, on-device, no server) is the harder, less reliable
half. Build barcode first, and make it fill the form rather than save silently.
A scanner that quietly writes a wrong protein number is worse than typing it.


---

## What changed in v4 (Nov 2026)

**Confirm buttons name their own action.** `confirmSheet` had a hardcoded
"Delete" label, so the button that SAVED a finished workout was red and said
Delete. `confirmLabel` is now a required argument that throws if omitted, which
removes the possibility rather than fixing nine instances and leaving the trap
set for the tenth.

**Progress tab.** One exercise at a time, two charts: working weight over time
and best reps at that weight. Rules come from the plotting notes: the day's
weight is whichever one carried the most sets (ties to the heavier), reps is the
best set at that weight, the number above each point is sets logged, and a
diamond marks a weight increase. The reps chart bands your target range so
"ready to bump" is something you see rather than something you work out.

Two things it refuses to do quietly. A point where weight and reps look
transposed is flagged, not silently swapped. A weight discontinuity of more than
2x is flagged as a probable in-place rename, not smoothed over. Both say so on
the card, because a chart that corrects your data behind your back is a chart
you cannot use to catch your own mistakes.

**Per-side tracking.** Any exercise can be marked unilateral. The set form grows
an L/R toggle that defaults to whichever side you have done fewer of, prefills
from the last set on that same side, and the Progress tab can chart left and
right separately. A left/right imbalance is invisible in a merged line.

**Edit exercises inside a workout.** Tap the exercise name on its card. Archiving
is disabled there, because archiving a movement you are mid-way through logging
is never what you meant.

**Meals.** The unit of logging is now a recipe, not an ingredient. One tap logs
the whole bowl. Underneath it still writes one entry per ingredient sharing a
`mealLogId`, so the day your beef is 8 oz instead of 6.5 you edit one number.
The four meal prep recipes are preloaded, with per-serving macros derived from
the per-bowl table and checked to reconcile to its stated totals.

Restoring a pre-meals backup replaces `foods` wholesale, which would orphan the
recipe ingredients. `repairMealLinks()` runs after every import: it prunes items
whose food is gone, drops meals left empty, and re-seeds. Without it a restore
leaves you a meal list that looks fine and totals zero.

**Bodyweight.** The input is on the card instead of behind a sheet, Enter
submits, and there is a chart with a least-squares trend in lb/week. A single
weigh-in is water; the slope is the signal.

**Lime, not amber.** Both themes re-derived, with neutrals shifted cool-green to
match and every pair contrast-checked (light accent 5.1:1 on white, dark accent
12.1:1 on the dark ground).

---

## v5: repairing history

Until v5 there was no way to look at a finished workout, let alone fix a number
in it. A typo logged in October was permanent. Progress now carries a **Sessions**
list under the charts: every past set is tappable, correctable and deletable, and
every change stamps `editedAt` so a corrected row keeps an "edited" tag and never
passes as something logged at the time.

The two chart warnings became actions rather than complaints:

**Swap weight and reps.** Shows exactly which sets change and what each becomes,
then does it on your confirmation. Still never automatic.

**Split at a date.** For an exercise renamed in place, which leaves two different
movements behind one id and a meaningless line between them. Splitting moves
every set on or before the break to a new exercise you name; the current one
keeps its recent sets, because the name describes what you do now. The split-off
exercise is archived, so it stays out of pickers and keeps its charts.

Order matters when a history has both problems: **swap first, then split.** A
transposed entry (8 lb × 90) looks like a weight discontinuity on its own, so
fixing it first removes a phantom split point.


### Targets moved onto the Exercise

v0.1 put rep targets on ProgramExercise, the day+exercise pairing, so one lift
could be 5x5 on a heavy day and 3x12 on a volume day. That was right in the
abstract and wrong in practice: there is one program, each exercise appears
once, and changing a rep range meant opening the program builder, which nobody
ever did. The result was all 26 exercises sitting on the 8-12 default, so
"ready to bump" could only fire at 12 and no compound ever lit up.

The rep range is also a property of the movement rather than the day. "Bumps at
10" is roughly what makes something a compound. So `targetSets`,
`targetRepsLow`, `targetRepsHigh` and `bumpAfterSets` now live on the Exercise
and are edited wherever you can see it, including by tapping its name
mid-workout. ProgramExercise keeps rest and ordering, which genuinely are
per-day. Schema version 3 backfills from whatever the program had.

### The bump rule is about your first sets

The old check compared the day's BEST set against the top of the range, so one
good set turned it green. The rule is the first N sets at the working weight all
reaching the top, default 2 and editable per exercise. A session of 8, 12, 10, 9
is not ready; 10, 10, 10 against an 8-10 target is. The card now states the rule
and your last session's reps in order, so a grey pill explains itself.

### Importing an old backup normalizes it

IndexedDB upgrades run once, when the database opens. A restore happens long
after and writes rows in whatever shape the backup had, so a v1 export dropped
into a v3 database leaves old-shaped rows behind a current version number, and
the upgrade never runs again to fix them. `normalizeImported()` re-applies the
backfills after every import. Without it, exercises restored from an old backup
have no targets, and editing one saves fields the others do not have.
