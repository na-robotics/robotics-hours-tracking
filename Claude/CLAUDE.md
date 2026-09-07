# Robotics Lab Attendance Tracker

Lab hours tracking for a high school robotics team. Students scan a QR ID card on a
wall-mounted tablet when they enter and again when they leave. Admins get a timesheet,
per-student stats, and student-written session summaries with photos.

Lab time only counts if it is written up. On scan-out a student gets an email with a
private link to their summary form; a session with no summary after the grace period is
marked `rejected` by a nightly job and stops counting until a summary arrives or a coach
recovers it.

## Stack (decided — do not propose alternatives)

| Layer | Choice |
| --- | --- |
| Frontend | Plain static HTML/CSS/JS. No build step, no npm, no framework, no bundler. Vanilla ES modules only. |
| Hosting | GitHub Pages, serving the repo as-is. |
| Backend | One Google Apps Script Web App, acting as a JSON API. |
| Database | A Google Sheet (5 tabs). |
| Photo storage | A Google Drive folder, written to by Apps Script. |

Everything must stay on free tiers with no credit card. That rules out Firebase Storage
and Supabase. Do not introduce a dependency that requires a build step or a paid tier.

## Hard constraints

These are the things that will silently break the app if ignored.

### 1. POSTs must use `Content-Type: text/plain`

Every POST to the Apps Script Web App sends `Content-Type: text/plain` and a JSON string
body, parsed server-side with `JSON.parse(e.postData.contents)`. Any other content type
(including `application/json`) triggers a CORS preflight `OPTIONS` request, which Apps
Script does not answer — the request fails outright. Do not "fix" this by setting
`application/json`.

```js
fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ action: 'scan', student_id: '1234567' })
});
```

### 2. The server assigns every timestamp

Clients never send a timestamp. The tablet's clock is not trusted. Apps Script stamps
`timestamp` at write time.

The single exception: scans queued while offline carry a client-supplied timestamp, and
that event MUST be written with `flagged = true` and `source` identifying it as an
offline replay. Flagged events are visible as unverified in the admin UI.

### 3. Email never blocks a scan

A student is standing at the tablet with a queue behind them. `actionScan_` appends the
outbound email to a queue in `ScriptProperties` — one fast write, **after** the lock is
released — and returns. A separate `flushSummaryEmails` trigger sends them minutes later.
Nothing in the mail path may throw into a scan: a scan that recorded a student's hours has
already succeeded.

`MailApp` allows 100 recipients a day on a consumer Gmail account (1,500 on Workspace),
counted across everything that account sends. The flusher checks
`MailApp.getRemainingDailyQuota()` before every send, warns in the log as it runs low, and
when it hits zero it **holds the rest for tomorrow** rather than discarding them.

### 4. Events are an append-only log

`Events` is an immutable event log. Never store a mutable `total_hours`, `currently_in`,
or `last_seen` field anywhere — not in the Sheet, not in a cache.

- Whether a student is in the lab = the `direction` of their most recent event.
- Total hours, session lists, and every statistic are recomputed from the log on read.
- Corrections are made by appending a new event with a `note`, never by editing a row.

**The one exception is `Events.status`.** It is a review flag — `active`, `rejected`,
`recovered` — not a fact about attendance, and it is written in place. `student_id`,
`timestamp`, `direction` and `source` stay immutable. Writing rejection as a superseding
event instead would destroy the IN/OUT pairing (there is no half-event to supersede) and
would make a nightly job that rejects forty sessions append eighty rows a night.

### 5. Rejected hours are filtered in exactly one place

`resolveEvents_()` drops rejected events on the way out of the raw sheet. Every total,
average, chart bucket and CSV column in the backend is computed from what it returns, so
the rule is applied once and no new calculation can forget it. Do not add a
`status !== 'rejected'` check anywhere else.

- Rejection always covers **both** ends of a session, so removing a rejected pair leaves
  the remaining IN/OUT alternation intact.
- `getTimesheet` with `include_rejected: true` asks for them back, tagged with
  `event_status`, purely so the admin page can draw the Rejected hours queue. Its own
  totals still skip them.
- The admin page mirrors this with one split in `load()`: `state.sessions` holds what
  counts, `state.rejected` holds the rest. Nothing downstream filters again.

### 6. Summary links carry a token, never a student ID

`summary.html?t=<token>` resolves server-side (`lookupToken`) to the student who owns it.
`lookupToken` deliberately does **not** return `student_id`, and `submitSummary` accepts
the token in its place.

A 7-digit ID is a credential — it is exactly what `scan` and `enroll` accept — and these
links live in inboxes, browser histories and forwarded screenshots. Never put a raw
student ID in a URL, and never widen `lookupToken`'s response to include one.

### 7. QR only

The QR payload is a bare 7-digit number and nothing else — e.g. `1234567`. No URL, no
prefix, no JSON. Validate with `/^\d{7}$/` before hitting the API.

Restrict the barcode detector to QR:

```js
const detector = new BarcodeDetector({ formats: ['qr_code'] });
```

Do not scan for linear/1D formats. It wastes frames on a tablet that is already running
a live camera feed.

### 8. Only retryable failures may be queued

`ApiError.isRetryable` — not `isNetwork` — decides whether the tablet queues a
scan. Retryable means the same request could plausibly succeed later: no answer
at all, a 5xx, or `retryable:true` from the server (lock contention).

A 4xx must never be retryable. A wrong URL or a dead deployment would otherwise
queue every scan behind a green "saved, will sync" that never syncs, and the
loss would surface weeks later as a hole in the timesheet.

### 9. The service worker caches the shell, never the API

`sw.js` handles **only same-origin GET** requests. Every API call is a POST to
`script.google.com`, so it fails both tests and goes straight to the network.

This is not a style preference. A stale cached roster would show an old name; a
stale cached *scan response* would tell a student "you're checked out" while
nothing reached the sheet, and would make a failed scan look successful so the
offline queue never fires. Do not add same-origin API endpoints without changing
that rule alongside them.

Pages are network-first (so a deploy lands immediately, with cache as the
offline fallback); static assets are stale-while-revalidate. Bump `VERSION` in
`sw.js` to retire an old cache.

## Sheet schema

Five tabs. Column order is the contract — Apps Script reads by index, so do not reorder
or insert columns in the middle.

**`Students`**

| Column | Notes |
| --- | --- |
| `student_id` | 7-digit string. Keep as text, not a number — leading zeros matter. |
| `name` | |
| `grade` | |
| `active` | Inactive students stay in the sheet; their history is preserved. |
| `created_at` | Server-assigned. |
| `email` | Optional. The tablet's enrollment sheet has a Skip button and an empty value is a normal answer, not an error. Editable from the admin roster. |
| `summary_token` | 32 random URL-safe chars, minted at enrollment for **every** student, email or not. Backfilled by `initializeSheets()`. Never returned by a public endpoint. |
| `team_id` | Optional. Blank means Unassigned, which is the normal starting state — see Teams. Written only by the admin page. |

**`Events`** — append-only

| Column | Notes |
| --- | --- |
| `event_id` | |
| `student_id` | |
| `timestamp` | Server-assigned, except flagged offline replays. |
| `direction` | `in` or `out`. |
| `source` | Which client produced it (e.g. tablet scanner, offline queue, admin). |
| `flagged` | `true` when the timestamp is unverified or the event needs review. |
| `note` | Free text; used for corrections and admin annotations. |
| `status` | `active` (blank counts as active), `rejected`, `recovered`. The only mutable cell in Events — see hard constraint 4. |

**`Summaries`**

| Column | Notes |
| --- | --- |
| `summary_id` | |
| `student_id` | |
| `session_date` | |
| `text` | Student-written. |
| `photo_urls` | Drive URLs, written by Apps Script after upload. |
| `submitted_at` | Server-assigned. |

**`Teams`**

| Column | Notes |
| --- | --- |
| `team_id` | `tm_` + 12 hex. Minted server-side; this is what `Students.team_id` points at. |
| `name` | Unique, case-insensitively. Renaming writes this one cell — see Teams. |
| `created_at` | Server-assigned. |

**`Config`** — `key`, `value`. Runtime settings that must not require a redeploy.

| Key | Notes |
| --- | --- |
| `admin_pin` | The one real secret. Lives here and nowhere else. |
| `lab_open`, `lab_close` | `HH:mm`. `lab_close` sets the auto-close time and the nightly trigger's hour. |
| `max_session_minutes` | Ceiling for auto-close **and** for manual entry. |
| `scan_debounce_seconds` | |
| `timezone` | Overrides the script timezone so date math has one source. |
| `drive_folder_id` | |
| `grace_period_hours` | Default `24`. How long after scanning out a student has to submit a summary. Read by `rejectUnloggedSessions()` and quoted in the email, so the two always agree. Values ≤ 0 fall back to the default. |
| `summary_email_immediate` | Default `true`. Set `false` to drop the one-shot trigger and let the recurring flusher do all delivery. |
| `summary_base_url` | Public URL of `summary.html`. **Ships empty** — until it is set, no scan-out emails are sent and `flushSummaryEmails` says so in the log. |

## Teams

Subteams — Build, Programming, Business — exist purely so a coach can group and
filter the roster. They are **roster data, not attendance data**, and three rules keep
that true:

- **Nothing is derived from a team.** `Events` stores only `student_id`, and every hour,
  session, average and chart bucket is recomputed from the log, so moving a student
  between teams changes what the totals are *grouped by* and never what they are. There
  is no migration, no recount and no history to keep.
- **Students carry `team_id`, not a team name.** A rename is one cell in `Teams`, not a
  rewrite of every member's row that could die halfway through.
- **Unassigned is not a team.** It is the absence of one — an empty `team_id` — which is
  what every row holds after the migration and what a student falls back to when their
  team is deleted. It has no row, cannot be renamed and cannot be removed. In the admin
  page it is the empty string, and it sorts last in every team view.

`deleteTeam` is the only place in the backend that deletes a row, and it is safe to
because a team holds no history: it clears `Students.team_id` for the members inside the
same lock, so there is no window where a row points at a team that is gone.

Teams are **admin-only**. The tablet never sees them — a student in a queue is not asked
which subteam they are on — so `enroll` writes a blank `team_id` and `scan` never reads
one. The team list rides along on `getRoster` rather than behind its own fetch, because
the admin page cannot draw a single row without both.

## Sessions that were never scanned

Two ways a session exists without a matching pair of card taps, and they are different:

- **`editEvent`** supersedes an event that exists. Use it to fix a time that was recorded
  wrongly.
- **`addManualSession`** writes a whole IN/OUT pair with `source: "manual"` for the night
  the tablet was unplugged, where there is no event to correct. The server validates end
  after start, no overlap with a session that student already has (rejected ones included,
  or a late recovery would double-count), and under `max_session_minutes`.

Manual sessions are **exempt from summary rejection**: a coach entering a session by hand
is the verification a summary would have provided. Both rows are written `flagged`, and
the admin UI marks them alongside auto-closed ones.

## The nightly job

One trigger, on `nightlyMaintenance()`, which runs `autoCloseOpenSessions()` and **then**
`rejectUnloggedSessions()`. The order is not cosmetic and must not be split across two
triggers:

- Rejection only looks at *completed* sessions, so a student still checked in is invisible
  to it. If rejection ran first, the session the closer is about to write would be skipped
  that night.
- An auto-closed OUT is *backdated* to lab close, so measuring the grace period from its
  timestamp would start the clock before the row existed. `nightlyMaintenance()` therefore
  passes the closer's new event ids to the rejecter as `skipEventIds`, and those sessions
  are judged on the next run. That is what guarantees a full grace period no matter how
  short `grace_period_hours` is set.

A late summary self-heals: `submitSummary` flips any rejected session for that student and
date to `recovered` on the spot, without an admin.

## Files

```
index.html              scanner (tablet) — registers the service worker
admin.html              roster, teams, timesheet, needs-review + rejected-hours queues,
                        manual session entry, student detail
summary.html            student summary submission (phone); ?t=<token> skips ID entry
css/styles.css          shared styles
js/api.js               shared API client — the only place fetch() is called
js/scanner.js           reusable QR scanner: camera lifecycle + decode loop
js/vendor/jsqr.js       vendored jsQR 1.4.0 — the iPad's only decode path
config.js               the deployed Apps Script URL (committed — see Secrets)
sw.js                   service worker — caches the shell, never the API
manifest.webmanifest    Add to Home Screen metadata
icons/                  app icons (192, 512, maskable, apple-touch, favicon)
apps-script/Code.gs     the entire backend
```

`js/api.js` is the only module that talks to the network. Pages call into it; they do not
call `fetch` themselves.

## Apps Script triggers

Two, both installed by hand from the editor. Re-running an installer is idempotent.

| Function | Installer | Schedule |
| --- | --- | --- |
| `nightlyMaintenance` | `installNightlyTrigger()` | daily, the hour after `lab_close` |
| `flushSummaryEmails` | `installSummaryEmailTrigger(minutes)` | every 5 minutes; pass 1, 10, 15 or 30 to change it |

Apps Script fires time triggers on a **best-effort** schedule. The interval is a floor, not
a promise — a 5-minute trigger has been observed slipping to 26. `flushSummaryEmails` logs
how long each email actually waited and warns past 15 minutes, so this is measurable rather
than guessed at.

That is why the recurring trigger is a **safety net, not the delivery mechanism**. A
scan-out schedules a one-shot `.after(30s)` trigger (`kickSummaryFlush_`), which is the
only way to get a bounded delay out of Apps Script. It is strictly an optimisation:

- Scans inside the same 90 seconds share one trigger, so a team leaving together creates
  one, not twenty.
- The flusher deletes the spent trigger when it runs, so they cannot pile up against the
  20-per-user cap. It refuses to create one past 12 project triggers.
- Every failure path — quota, an exception, `summary_email_immediate: false` — falls back
  to the recurring flusher. It must never be something the mail depends on, and it must
  never be able to fail a scan.

`flushSummaryEmails` peeks at the queue **before** taking the script lock. It runs every
few minutes forever and the queue is nearly always empty, so grabbing a lock the scanner
also wants — and blocking on it while a student is mid-scan — would be pure contention for
a run with nothing to do.

There must be **no** trigger pointing straight at `autoCloseOpenSessions` or
`rejectUnloggedSessions` — that runs the closer outside the ordering the rejecter depends
on. `installNightlyTrigger()` deletes any it finds. `installAutoCloseTrigger()` is kept as
an alias for the same thing so an old bookmark cannot reinstall the broken shape.

## Diagnostics

Run these from the editor — they use the saved code, so no redeploy is needed to use one.

- **`diagnoseSummaryEmail(studentId)`** — "I scanned out and no email arrived." Walks the
  whole chain in the order it breaks: schema migrated, `summary_base_url` set, triggers
  installed, quota left, what is queued, and whether the student has an email and a token.
- **`refreshCaches()`** — drops every cached tab.
- **`sendTestSummaryEmail(studentId)`** — sends the scan-out email without scanning. With
  no argument it mails **you**, the account running the script, using the first student's
  link; pressing Run on a function called "send…" must not put mail in a kid's inbox.

The editor's Run button cannot pass an argument, so anything meant to be run from it has
to work with none. Keep it that way for functions added here.

### The table cache cannot see a hand edit

Every write that goes through `Code.gs` invalidates the cached tab for itself. Nothing can
do that when a value is typed **directly into the Sheet**, so a hand-edited email, name or
grade is invisible to the backend for up to six hours (`CACHE_TTL_SEC`).

Prefer the admin page, which invalidates for you. After editing a tab by hand, run
`refreshCaches()`. `diagnoseSummaryEmail()` detects this specific case by comparing
`loadTable_` (the sheet) against `readTable_` (the cache) and naming the students that
disagree.

## Secrets and test data

- **Never commit a real student ID.** Use `1234567` as the dummy ID in all test code,
  examples, and documentation. Same for email addresses: use `example.com`.
- **Never commit a real `summary_token`.** They live only in the Sheet and in students'
  inboxes. A token is a bearer credential for one student's summary form.
- **The deployed Apps Script URL is public, by decision.** It lives in `config.js`,
  which IS committed. A static GitHub Pages site cannot hold a secret: anything the
  browser needs to send a request, a visitor can read from the network tab. Keeping
  the file out of the repo would only have hidden the URL from scrapers, not from
  anyone loading the page.
- **Consequences to design around.** `scan` and `enroll` take no PIN, so anyone with
  the URL can append events. That is accepted: `Events` is append-only, `enroll`
  rejects duplicates, `scan` only accepts IDs already on the roster, and a coach
  voids junk with `deleteEvent` while the originals stay visible for audit. Treat
  stray rows as maintenance, not as a breach.
- **The admin PIN is the one real secret, and it is not in this repo.** It lives only
  in the `Config` tab of the Sheet. Never put it in `config.js` or any committed file.
- This project sits inside a git repository rooted at the user's home directory. Verify
  what is staged before committing; do not `git add -A` from the repo root.
