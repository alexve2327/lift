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
3. Go to **Settings** → **Pages**.
4. Under *Source*, pick **Deploy from a branch**, branch `main`, folder `/ (root)`.
5. Wait about a minute. Your URL will be `https://<you>.github.io/<repo>/`.

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
`lift-v1` to `lift-v2` is what tells it to fetch fresh files.

Your logged data is untouched by this. The cache holds about 100KB of code; your
sets and meals are in IndexedDB, which the service worker never looks at.

---

## What's in here

```
index.html            page shell, iOS meta tags, safe-area setup
app.webmanifest       name, icons, standalone display mode
sw.js                 service worker: the offline cache
css/app.css           one stylesheet, dark and light themes
vendor/dexie.mjs      IndexedDB wrapper, vendored so it works offline
js/
  app.js              router, tab bar, and the persistent rest-timer bar
  db.js               schema, indexes, and every read and write
  ui.js               the whole rendering layer, in about 90 lines
  util.js             dates, formatting, e1RM, BMR
  timer.js            rest timer
  views/
    today.js          the workout screen
    food.js           the nutrition tab
    library.js        exercises, programs, foods
    settings.js       profile, calorie estimate, backup
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
