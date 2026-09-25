/**
 * Robotics Lab Attendance Tracker — Apps Script backend.
 *
 * This file is the entire server. It is bound to the tracking Spreadsheet and
 * deployed as a Web App (Deploy > New deployment > Web app, execute as Me,
 * access Anyone). The static frontend on GitHub Pages talks to it as a JSON API.
 *
 * FIRST-TIME SETUP
 *   1. Run initializeSheets() once from the editor. Grant the permissions it asks
 *      for. It creates the tabs, the Drive folder, and the Config defaults, and
 *      logs the generated admin PIN.
 *   2. Set Config.summary_base_url to the public URL of summary.html, so the
 *      scan-out emails have a link to send.
 *   3. Run installNightlyTrigger() once — it schedules nightlyMaintenance(),
 *      which auto-closes forgotten sessions and THEN rejects unlogged ones.
 *   4. Run installSummaryEmailTrigger() once, for the every-5-minutes flusher
 *      that actually sends the queued summary emails.
 *   5. Deploy as a Web App and paste the /exec URL into the frontend's config.js.
 *
 * ============================ READ THIS BEFORE EDITING =====================
 *
 * CORS / Content-Type
 *   Every POST from the browser sends Content-Type: text/plain with a JSON
 *   string body, and this file parses it with JSON.parse(e.postData.contents).
 *   That looks wrong and it is deliberate. text/plain is one of the three
 *   "simple request" content types, so the browser sends it WITHOUT a CORS
 *   preflight. Apps Script Web Apps cannot answer an OPTIONS preflight — there
 *   is no doOptions() — so the moment a request becomes non-simple it fails
 *   before doPost() is ever called. Setting application/json "properly" on the
 *   client breaks every write in the app. Do not do it.
 *   For the same reason, no custom request headers (no Authorization, no
 *   X-Anything) — those also trigger a preflight. The admin PIN travels in the
 *   JSON body instead.
 *
 * Timestamps
 *   The server assigns every timestamp. The tablet's clock is not trusted.
 *   The only exceptions are offline-queued scans (syncQueue) and admin
 *   corrections, which carry a supplied timestamp and are ALWAYS written with
 *   flagged = true so the admin UI can show them as unverified.
 *
 * Append-only log
 *   Events is immutable, with ONE exception: the `status` column, which is a
 *   review flag rather than a fact about attendance (active / rejected /
 *   recovered). Nothing here ever rewrites or deletes an Events row,
 *   and no total_hours / currently_in / last_seen is ever stored. Every
 *   statistic is recomputed from the log on read. Corrections append a new row
 *   whose note supersedes or voids an earlier event_id — see resolveEvents_().
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var VERSION = '1.0.0';

var TAB_STUDENTS  = 'Students';
var TAB_EVENTS    = 'Events';
var TAB_SUMMARIES = 'Summaries';
var TAB_CONFIG    = 'Config';
var TAB_TEAMS     = 'Teams';

/**
 * Column order is the contract. Rows are read by index, so never reorder these
 * or insert a column in the middle — append at the end if you must extend.
 */
var HEADERS = {};
HEADERS[TAB_STUDENTS]  = ['student_id', 'name', 'grade', 'active', 'created_at', 'email', 'summary_token', 'team_id'];
HEADERS[TAB_EVENTS]    = ['event_id', 'student_id', 'timestamp', 'direction', 'source', 'flagged', 'note', 'status'];
HEADERS[TAB_SUMMARIES] = ['summary_id', 'student_id', 'session_date', 'text', 'photo_urls', 'submitted_at'];
HEADERS[TAB_CONFIG]    = ['key', 'value'];
HEADERS[TAB_TEAMS]     = ['team_id', 'name', 'created_at'];

var DRIVE_FOLDER_NAME = 'Robotics Lab Summaries';

var DIR_IN   = 'in';
var DIR_OUT  = 'out';
var DIR_VOID = 'void';   // marker row for a voided event; never a real presence event

var SOURCE_TABLET    = 'tablet';
var SOURCE_OFFLINE   = 'offline';
var SOURCE_ADMIN     = 'admin';
var SOURCE_AUTOCLOSE = 'auto-close';
var SOURCE_MANUAL    = 'manual';    // a coach typed the whole session in by hand

/**
 * Events.status — the lifecycle of an event, NOT a fact about attendance.
 *
 *   active     the default; counts toward hours
 *   rejected   the session it belongs to went past the grace period with no
 *              summary, so it stops counting
 *   recovered  a late summary arrived and put it back
 *   verified   a coach checked a flagged session's times and signed it off,
 *              which takes it out of the Needs review queue
 *
 * This is the only mutable cell in Events, and it is deliberately not part of
 * the append-only rule: student_id, timestamp, direction and source are the
 * immutable record of what happened, while status records what a policy later
 * decided about it. Writing rejection as a superseding event instead would
 * destroy the pairing (there is no "half an event" to supersede) and would make
 * a nightly job that rejects 40 sessions append 80 rows every night.
 */
var STATUS_ACTIVE    = 'active';
var STATUS_REJECTED  = 'rejected';
var STATUS_RECOVERED = 'recovered';
var STATUS_VERIFIED  = 'verified';

// Column index (1-based) of Events.status. Column order is the contract.
var COL_EVENT_STATUS = 8;
// Column indexes of the Students columns written in place after enrollment.
var COL_STUDENT_EMAIL = 6;
var COL_STUDENT_TOKEN = 7;
var COL_STUDENT_TEAM  = 8;
// Column index of Teams.name, the only cell a rename touches.
var COL_TEAM_NAME     = 2;

// Outbound summary emails wait here between the scan that created them and the
// flushSummaryEmails trigger that sends them. See "Summary emails" below.
var MAIL_QUEUE_KEY   = 'summary_mail_queue';
// Bookkeeping for the one-shot "send it now" trigger — see kickSummaryFlush_.
var MAIL_KICK_KEY    = 'summary_mail_kick';
var MAIL_KICK_DELAY_MS = 30 * 1000;
// If a kick is already due within this window, ride on it instead of making
// another. One trigger serves everyone who scans out in the same minute.
var MAIL_KICK_WINDOW_MS = 90 * 1000;
// Apps Script allows 20 triggers per user per script. Stay well clear: if the
// project is already crowded the recurring flusher still picks the mail up.
var MAIL_KICK_TRIGGER_CAP = 12;
var MAIL_QUEUE_MAX   = 400;
var MAIL_MAX_AGE_MS  = 24 * 3600 * 1000;
var MAIL_QUOTA_WARN  = 15;

var LOCK_TIMEOUT_MS  = 25000;
var MAX_PHOTOS       = 4;
var MAX_PHOTO_BYTES  = 8 * 1024 * 1024;
var MAX_SUMMARY_CHARS = 4000;

// Per-execution caches. Apps Script globals live for one execution only, which
// is exactly the lifetime we want: fresh on every request, free within one.
var CONFIG_CACHE = null;
var ID_COUNTER = 0;

// ---------------------------------------------------------------------------
// Response helpers — every response is {ok:true,data:...} or {ok:false,error:"..."}
// ---------------------------------------------------------------------------

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data) {
  return { ok: true, data: data === undefined ? null : data };
}

/** Throw a client-facing error. doPost turns it into {ok:false,error:message}. */
function fail_(message) {
  var e = new Error(message);
  e.apiError = true;
  throw e;
}

/**
 * Like fail_, but marks the response {retryable:true}.
 *
 * Only for failures where the SAME request would plausibly succeed a moment
 * later — lock contention, essentially. The tablet queues a retryable scan
 * instead of discarding it, which matters because contention is exactly when
 * two students are at the door at once.
 */
function failRetryable_(message) {
  var e = new Error(message);
  e.apiError = true;
  e.retryable = true;
  throw e;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Health check. Open the /exec URL in a browser to confirm the deployment is
 * live and pointed at an initialized spreadsheet. Returns no student data.
 */
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tabs = {};
    var missing = [];
    var names = [TAB_STUDENTS, TAB_EVENTS, TAB_SUMMARIES, TAB_CONFIG, TAB_TEAMS];
    for (var i = 0; i < names.length; i++) {
      var sh = ss.getSheetByName(names[i]);
      if (!sh) { missing.push(names[i]); tabs[names[i]] = null; continue; }
      tabs[names[i]] = Math.max(0, sh.getLastRow() - 1);   // data rows, excluding header
    }
    var cfg = missing.length ? {} : readConfig_();
    return json_(ok_({
      service: 'robotics-lab-attendance',
      version: VERSION,
      time: nowIso_(),
      timezone: tz_(),
      spreadsheet: ss.getName(),
      rows: tabs,
      missing_tabs: missing,
      initialized: missing.length === 0 && !!cfg.drive_folder_id && !!cfg.admin_pin,
      admin_pin_set: !!cfg.admin_pin,
      drive_folder_set: !!cfg.drive_folder_id
    }));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * The single write endpoint. Body is a JSON string sent as text/plain — see the
 * CORS note at the top of this file before changing anything about that.
 */
function doPost(e) {
  var payload;
  try {
    if (!e || !e.postData || !e.postData.contents) fail_('empty request body');
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      fail_('body is not valid JSON');
    }
    if (!payload || typeof payload !== 'object') fail_('body must be a JSON object');

    var action = String(payload.action || '').trim();
    if (!action) fail_('missing action');

    switch (action) {
      // Tablet / student actions
      case 'scan':          return json_(actionScan_(payload));
      case 'enroll':        return json_(actionEnroll_(payload));
      case 'syncQueue':     return json_(actionSyncQueue_(payload));
      case 'submitSummary': return json_(actionSubmitSummary_(payload));
      case 'lookupStudent': return json_(actionLookupStudent_(payload));
      case 'lookupToken':   return json_(actionLookupToken_(payload));

      // Admin actions — every one of these requires the PIN in the body.
      case 'getRoster':     return json_(actionGetRoster_(payload));
      case 'getTimesheet':  return json_(actionGetTimesheet_(payload));
      case 'getStudent':    return json_(actionGetStudent_(payload));
      case 'getSummaries':  return json_(actionGetSummaries_(payload));
      case 'deleteSummary': return json_(actionDeleteSummary_(payload));
      case 'editEvent':     return json_(actionEditEvent_(payload));
      case 'deleteEvent':   return json_(actionDeleteEvent_(payload));
      case 'setActive':     return json_(actionSetActive_(payload));
      case 'setName':       return json_(actionSetName_(payload));
      case 'setEmail':      return json_(actionSetEmail_(payload));
      case 'addManualSession': return json_(actionAddManualSession_(payload));
      case 'recoverEvents': return json_(actionRecoverEvents_(payload));
      case 'verifySessions': return json_(actionVerifySessions_(payload));
      case 'getTeams':      return json_(actionGetTeams_(payload));
      case 'createTeam':    return json_(actionCreateTeam_(payload));
      case 'renameTeam':    return json_(actionRenameTeam_(payload));
      case 'deleteTeam':    return json_(actionDeleteTeam_(payload));
      case 'setTeam':       return json_(actionSetTeam_(payload));

      default: fail_('unknown action: ' + action);
    }
  } catch (err) {
    if (err && err.apiError) {
      var body = { ok: false, error: err.message };
      if (err.retryable) body.retryable = true;
      return json_(body);
    }
    // Unexpected: log the stack for the execution log, return something terse.
    console.error('doPost failed', err && err.stack ? err.stack : err,
                  'action=' + (payload && payload.action));
    return json_({ ok: false, error: 'server error: ' + String(err && err.message ? err.message : err) });
  }
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Run fn while holding the script lock. Two tablets scanning at the same instant
 * must not both read "last event = in" and both append an OUT, and two appends
 * must not target the same row. Every read-decide-write path goes through here,
 * with the READ inside the lock — locking only the write would not help.
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    // Retryable on purpose: another scan is mid-write. Reporting this as a
    // plain error made the tablet drop the scan outright.
    failRetryable_('the sheet is busy, try again');
  }
  try {
    return fn();
  } finally {
    // Push pending writes out before releasing, so the next holder reads them.
    try { SpreadsheetApp.flush(); } catch (flushErr) { console.error(flushErr); }
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sheet access
// ---------------------------------------------------------------------------

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) fail_('missing tab "' + name + '" — run initializeSheets() once from the Apps Script editor');
  return sh;
}

/**
 * Read a whole tab in ONE getValues() call and hand back plain objects.
 *
 * Apps Script charges roughly a fixed round-trip per Range call, so a loop of
 * getRange().getValue() over 2,000 events takes tens of seconds while a single
 * getDataRange().getValues() takes milliseconds. Read once, work in memory,
 * write once. Nothing in this file may call getRange() inside a row loop.
 *
 * Each object carries _row (1-based sheet row) for the rare in-place update —
 * Students.active — which is the only mutable cell in the whole schema.
 */
function readTable_(name) {
  if (TABLE_MEMO_.hasOwnProperty(name)) return TABLE_MEMO_[name];
  var rows = cacheGetTable_(name);
  if (!rows) {
    // Note the generation BEFORE touching the sheet, and refuse to cache if it
    // moved while we were reading — see cachePutTable_.
    var gen = tableGen_(name);
    rows = loadTable_(name);
    cachePutTable_(name, rows, gen);
  }
  TABLE_MEMO_[name] = rows;
  return rows;
}

/** The uncached read. Only readTable_ and the cache layer call this. */
function loadTable_(name) {
  var values = sheet_(name).getDataRange().getValues();
  var header = HEADERS[name];
  if (!values.length) return [];

  // Column order is the contract; refuse to guess if someone reordered them.
  for (var c = 0; c < header.length; c++) {
    var cell = String(values[0][c] === undefined ? '' : values[0][c]).trim().toLowerCase();
    if (cell === header[c]) continue;
    // A blank cell is the ordinary case of a tab that predates a column added
    // later. That is a migration, not a corruption, and it has a one-line fix.
    if (cell === '') {
      fail_('tab "' + name + '" is missing the "' + header[c] + '" column — ' +
            'run initializeSheets() once from the Apps Script editor');
    }
    fail_('tab "' + name + '" column ' + (c + 1) + ' should be "' + header[c] +
          '" but is "' + values[0][c] + '" — column order is the contract');
  }

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (isBlankRow_(row)) continue;
    var obj = { _row: r + 1 };
    for (var i = 0; i < header.length; i++) obj[header[i]] = row[i];
    out.push(obj);
  }
  return out;
}

function isBlankRow_(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

/**
 * Append rows to a tab in one setValues() call. Caller must hold the lock.
 *
 * This is also the single choke point for cache invalidation on the append-only
 * tabs: scan, enroll, syncQueue, submitSummary, editEvent, deleteEvent and
 * deleteSummary all reach the sheet through here, so none of them has to
 * remember to drop the key. The two in-place cell writes (Students.active and
 * Students.name) do not, and invalidate for themselves.
 */
function appendRows_(name, rows) {
  if (!rows.length) return;
  var sh = sheet_(name);
  var width = HEADERS[name].length;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  invalidateTable_(name);
}

// ---------------------------------------------------------------------------
// Table cache
//
// Reading a tab costs a Sheets round-trip — tens to hundreds of milliseconds,
// and every admin page load wants Students, Events and Summaries. CacheService
// is an order of magnitude faster, so the tabs are serialized into it and the
// sheet is only touched on a miss or after a write.
//
// Three things this layer must get right, in order of how badly they bite:
//
//   1. It is never a source of truth. Every failure — a miss, an eviction, a
//      quota error, a value that will not parse — falls through to the sheet.
//      Nothing here may throw.
//   2. A write invalidates before the next read. Every append goes through
//      appendRows_ above; the two setValue writes call invalidateTable_
//      themselves. A stale roster showing an archived student as active is the
//      failure this guards against.
//   3. Cached rows must be INDISTINGUISHABLE from freshly read ones. A sheet
//      cell can hold a Date, and JSON turns Dates into strings — which would
//      quietly change summaryDate_(), because it branches on `instanceof Date`
//      and formats a real Date in the local timezone but reads a string
//      verbatim. Dates are therefore tagged on the way in and revived on the
//      way out, so both paths hand back the same objects.
// ---------------------------------------------------------------------------

/** Per-execution memo: two readTable_(Events) in one request cost one parse. */
var TABLE_MEMO_ = {};

var CACHE_TTL_SEC = 21600;      // six hours, the CacheService maximum
var CACHE_CHUNK_CHARS = 32000;  // a cached value caps at 100KB; UTF-8 is <=3B/char
var CACHE_MAX_CHUNKS = 40;      // ~1.2MB of JSON; past that, just read the sheet

function cacheKey_(name) {
  // v2: Students grew email/summary_token and Events grew status. A v1 entry
  // holds rows without those fields, and serving one would look like every
  // student had no email and every event were unrejected.
  return 'tbl.v2.' + name;
}

function genKey_(name) {
  return 'gen.v1.' + name;
}

/**
 * The tab's current generation — an opaque token that changes on every write.
 *
 * This exists to close a race that dropping the key alone does not. Reads take
 * no lock, so a reader can load the sheet, a writer can then commit and
 * invalidate, and the reader can afterwards store what it read — parking data
 * that was already stale in a six-hour cache. Comparing the generation across
 * the sheet read catches exactly that overlap.
 *
 * A missing token (evicted, or a cold script) reads as "unknowable", which
 * makes the caller skip caching this once. Losing a cache fill is free;
 * serving a stale roster is not.
 */
function tableGen_(name) {
  try {
    var cache = CacheService.getScriptCache();
    var g = cache.get(genKey_(name));
    if (!g) {
      g = Utilities.getUuid();
      cache.put(genKey_(name), g, CACHE_TTL_SEC);
    }
    return g;
  } catch (err) {
    return null;
  }
}

/** Date -> {__d: epoch millis}. Everything else is already JSON-safe. */
function encodeRows_(rows) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var src = rows[i], dst = {};
    for (var k in src) {
      if (!src.hasOwnProperty(k)) continue;
      var v = src[k];
      if (v instanceof Date) {
        var t = v.getTime();
        dst[k] = isNaN(t) ? '' : { __d: t };
      } else {
        dst[k] = v;
      }
    }
    out.push(dst);
  }
  return out;
}

function decodeRows_(rows) {
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    for (var k in row) {
      if (!row.hasOwnProperty(k)) continue;
      var v = row[k];
      if (v && typeof v === 'object' && typeof v.__d === 'number') row[k] = new Date(v.__d);
    }
  }
  return rows;
}

/**
 * Read a tab out of the cache, or null on any kind of miss.
 *
 * Chunked, because a value caps at 100KB and Events outgrows that. The manifest
 * holds "<count>|<stamp>" and each chunk key carries the same stamp, so a
 * partially evicted or concurrently rewritten set can never be reassembled into
 * a Frankenstein table — a stamp mismatch or a missing chunk is just a miss.
 */
function cacheGetTable_(name) {
  try {
    var cache = CacheService.getScriptCache();
    var key = cacheKey_(name);
    var manifest = cache.get(key);
    if (!manifest) return null;

    var parts = String(manifest).split('|');
    var count = Number(parts[0]);
    var stamp = parts[1];
    if (!stamp || !(count > 0)) return null;

    var keys = [];
    for (var c = 0; c < count; c++) keys.push(key + '.' + stamp + '.' + c);
    var got = cache.getAll(keys);

    var json = '';
    for (var i = 0; i < keys.length; i++) {
      var piece = got[keys[i]];
      if (piece === null || piece === undefined) return null;   // evicted mid-set
      json += piece;
    }
    return decodeRows_(JSON.parse(json));
  } catch (err) {
    console.warn('table cache read failed for ' + name + ': ' + err);
    return null;
  }
}

function cachePutTable_(name, rows, gen) {
  try {
    if (!gen) return;                          // generation unknown: do not cache
    var json = JSON.stringify(encodeRows_(rows));
    var count = Math.ceil(json.length / CACHE_CHUNK_CHARS) || 1;
    if (count > CACHE_MAX_CHUNKS) return;      // too big to be worth the round-trips

    var key = cacheKey_(name);
    var stamp = Utilities.getUuid().replace(/-/g, '').substring(0, 8);
    var map = {};
    for (var c = 0; c < count; c++) {
      map[key + '.' + stamp + '.' + c] = json.substring(c * CACHE_CHUNK_CHARS,
                                                        (c + 1) * CACHE_CHUNK_CHARS);
    }
    var cache = CacheService.getScriptCache();
    // Someone committed a write while we were reading the sheet, so what we are
    // holding may already be out of date. Drop it rather than cache it.
    if (cache.get(genKey_(name)) !== gen) return;

    // Chunks first, manifest last: a reader that catches us mid-write finds no
    // manifest and reads the sheet, rather than finding one that points at
    // chunks which are not there yet.
    cache.putAll(map, CACHE_TTL_SEC);
    cache.put(key, count + '|' + stamp, CACHE_TTL_SEC);
  } catch (err) {
    console.warn('table cache write failed for ' + name + ': ' + err);
  }
}

/**
 * Drop a tab from the cache. Called after every write, inside the lock, so the
 * next reader misses and reloads.
 *
 * Only the manifest is deleted. The orphaned chunks expire on their own and can
 * never be read again, because the next write picks a fresh stamp.
 */
function invalidateTable_(name) {
  delete TABLE_MEMO_[name];
  if (name === TAB_CONFIG) CONFIG_CACHE = null;
  try {
    // Make the write durable FIRST. Apps Script buffers setValues, so dropping
    // the key while the row is still pending would let the next reader load the
    // sheet, miss the new row, and cache that for six hours.
    SpreadsheetApp.flush();
  } catch (err) {
    console.error('flush before invalidate failed: ' + err);
  }
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(cacheKey_(name));
    // Bump the generation so an in-flight reader that started before this write
    // discards what it read instead of caching it.
    cache.put(genKey_(name), Utilities.getUuid(), CACHE_TTL_SEC);
  } catch (err) {
    console.warn('table cache invalidate failed for ' + name + ': ' + err);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfig_() {
  if (CONFIG_CACHE) return CONFIG_CACHE;
  var cfg = {};
  var rows = readTable_(TAB_CONFIG);
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i].key || '').trim();
    if (k) cfg[k] = rows[i].value;
  }
  CONFIG_CACHE = cfg;
  return cfg;
}

function cfgStr_(key, fallback) {
  var v = readConfig_()[key];
  return (v === undefined || v === null || v === '') ? fallback : String(v).trim();
}

function cfgNum_(key, fallback) {
  var n = Number(cfgStr_(key, ''));
  return isFinite(n) && n > 0 ? n : fallback;
}

/** Script timezone, overridable from Config so date math has one source. */
function tz_() {
  return cfgStr_('timezone', Session.getScriptTimeZone());
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function newId_(prefix) {
  ID_COUNTER++;
  return prefix + '_' + Date.now().toString(36) + '_' +
         ID_COUNTER.toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

/**
 * Repair a student ID READ FROM THE SHEET. Sheets stores 7-digit IDs as text,
 * but a column that was pasted in before the format was set can come back as
 * the number 234567, so pad it back out.
 *
 * This is for sheet values only — never for client input, which must be exactly
 * seven digits already. Padding an incoming "12" into "0000012" would turn a
 * misread QR code into a lookup against someone else's ID.
 */
function normId_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (/^\d+$/.test(s) && s.length < 7) s = ('0000000' + s).slice(-7);
  return s;
}

/** Validate a client-supplied student ID. Strict: the QR payload is 7 digits. */
function requireId_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (!/^\d{7}$/.test(s)) fail_('student_id must be exactly 7 digits');
  return s;
}

function requireStr_(payload, field, max) {
  var v = payload[field];
  if (v === undefined || v === null || String(v).trim() === '') fail_('missing ' + field);
  var s = String(v).trim();
  if (max && s.length > max) fail_(field + ' is too long (max ' + max + ' characters)');
  return s;
}

function truthy_(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  return /^(true|yes|1|y)$/i.test(String(v).trim());
}

function nowIso_() {
  return new Date().toISOString();
}

/** Timestamps are stored as UTC ISO 8601 strings so they round-trip exactly. */
function toIso_(d) {
  return d.toISOString();
}

function parseTs_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v || '').trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Local calendar day of an instant, e.g. "2026-09-02". */
function dateKey_(d) {
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

/** Local wall-clock time of an instant, e.g. "18:42". */
function timeKey_(d) {
  return Utilities.formatDate(d, tz_(), 'HH:mm');
}

/** The instant of local "HH:mm" on the same local day as refDate. */
function localTimeOn_(refDate, hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  var day = Utilities.formatDate(refDate, tz_(), 'yyyy/MM/dd');
  var d = new Date(day + ' ' + ('0' + m[1]).slice(-2) + ':' + m[2] + ':00');
  return isNaN(d.getTime()) ? null : d;
}

function minutesBetween_(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

// ---------------------------------------------------------------------------
// The event log
// ---------------------------------------------------------------------------

function toEvent_(row) {
  var ts = parseTs_(row.timestamp);
  var id = String(row.event_id || '').trim();
  if (!id || !ts) return null;                     // malformed row: ignore, never crash a scan
  return {
    event_id: id,
    student_id: normId_(row.student_id),
    ts: ts,
    timestamp: toIso_(ts),
    direction: String(row.direction || '').trim().toLowerCase(),
    source: String(row.source || '').trim(),
    flagged: truthy_(row.flagged),
    note: String(row.note || '').trim(),
    status: normStatus_(row.status)
  };
}

/**
 * Events written before the status column existed have a blank cell, and a
 * blank means active. Anything unrecognised is also read as active: a typo in
 * the sheet must not silently delete somebody's hours.
 */
function normStatus_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (s === STATUS_REJECTED) return STATUS_REJECTED;
  if (s === STATUS_RECOVERED) return STATUS_RECOVERED;
  if (s === STATUS_VERIFIED) return STATUS_VERIFIED;
  return STATUS_ACTIVE;
}

/** The one place that decides whether an event's hours count. */
function counts_(status) {
  return normStatus_(status) !== STATUS_REJECTED;
}

/**
 * Turn raw Events rows into the effective log, oldest first.
 *
 * The sheet is append-only, so a correction is itself a row whose note starts
 * with a machine-readable marker naming the event it replaces:
 *
 *   supersedes:<event_id> — <reason>   a replacement event; the target drops out
 *   void:<event_id> — <reason>         a tombstone; both rows drop out
 *
 * Nothing is ever edited or deleted in the sheet — the original rows stay
 * visible there forever, they just stop counting here. Chains work: if B
 * supersedes A and C supersedes B, only C survives.
 */
function resolveEvents_(rows, includeRejected) {
  var kept = [];
  var dropped = {};
  for (var i = 0; i < rows.length; i++) {
    var ev = toEvent_(rows[i]);
    if (!ev) continue;
    var m = /^(void|supersedes):(\S+)/.exec(ev.note);
    if (m) {
      dropped[m[2]] = true;
      if (m[1] === 'void') dropped[ev.event_id] = true;   // the tombstone is not itself an event
    }
    kept.push(ev);
  }
  var out = [];
  for (var j = 0; j < kept.length; j++) {
    if (dropped[kept[j].event_id]) continue;
    if (kept[j].direction !== DIR_IN && kept[j].direction !== DIR_OUT) continue;
    // THE rejection filter. Every statistic in this file is computed from the
    // list resolveEvents_ returns, so dropping rejected events here is the one
    // and only place hours stop counting — no per-calculation filtering, and
    // no way for a new total to forget the rule. Rejection always covers both
    // ends of a session, so the pairing in buildSessions_ stays consistent.
    if (!includeRejected && !counts_(kept[j].status)) continue;
    out.push(kept[j]);
  }
  return sortByTs_(out);
}

function sortByTs_(events) {
  return events.sort(function (a, b) {
    var d = a.ts.getTime() - b.ts.getTime();
    return d !== 0 ? d : String(a.event_id).localeCompare(String(b.event_id));  // stable on ties
  });
}

function groupByStudent_(events) {
  var by = {};
  for (var i = 0; i < events.length; i++) {
    var sid = events[i].student_id;
    if (!by[sid]) by[sid] = [];
    by[sid].push(events[i]);
  }
  return by;
}

/**
 * Pair a single student's events into sessions.
 *
 *   closed   — an IN matched by an OUT: the normal case, the only one that counts
 *   open     — the last IN, still unmatched: the student is in the lab right now
 *   unclosed — an IN followed by another IN; the first never got an OUT
 *   orphan   — an OUT with no IN before it
 *   reversed — an OUT that lands BEFORE its IN, which would give negative time
 *
 * The last three are broken logs, not attendance. They are still returned, every
 * one of them carrying needs_review and a null duration, because the admin page
 * has to be able to show a coach what is wrong and let them fix it. Dropping
 * them here would make an orphan OUT invisible in every view — the row would
 * simply never appear, and nobody would know to correct it.
 *
 * 'reversed' cannot happen on the normal path: resolveEvents_ sorts ascending,
 * so an OUT always lands at or after the IN it closes, and a negative duration
 * is impossible by construction. The branch is kept as a guard — if the ordering
 * ever changes, a bad pair degrades into a flagged row with a null duration
 * instead of silently reporting "-142 min" or clamping to zero.
 */
function buildSessions_(events) {
  var sessions = [];
  var open = null;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.direction === DIR_IN) {
      if (open) sessions.push(makeSession_(open, null, 'unclosed'));
      open = e;
    } else {
      if (open) {
        var backwards = e.ts.getTime() < open.ts.getTime();
        sessions.push(makeSession_(open, e, backwards ? 'reversed' : 'closed'));
        open = null;
      } else {
        sessions.push(makeOrphan_(e));
      }
    }
  }
  if (open) sessions.push(makeSession_(open, null, 'open'));
  return sessions;
}

/** An OUT with nothing before it. There is no start time, so there is no duration. */
function makeOrphan_(outEv) {
  return {
    student_id: outEv.student_id,
    date: dateKey_(outEv.ts),
    status: 'orphan',
    in_event_id: null,
    out_event_id: outEv.event_id,
    in_time: null,
    out_time: outEv.timestamp,
    in_clock: null,
    out_clock: timeKey_(outEv.ts),
    minutes: null,
    flagged: !!outEv.flagged,
    needs_review: true,
    sources: [outEv.source],
    event_status: normStatus_(outEv.status)
  };
}

function makeSession_(inEv, outEv, status) {
  // Only a well-formed session has a duration. 'unclosed' and 'reversed' report
  // null rather than a guess, so nothing downstream can sum a broken row.
  var minutes = null;
  if (status === 'closed') minutes = Math.max(0, minutesBetween_(inEv.ts, outEv.ts));
  else if (status === 'open') minutes = Math.max(0, minutesBetween_(inEv.ts, new Date()));
  return {
    student_id: inEv.student_id,
    date: dateKey_(inEv.ts),
    status: status,
    in_event_id: inEv.event_id,
    out_event_id: outEv ? outEv.event_id : null,
    in_time: inEv.timestamp,
    out_time: outEv ? outEv.timestamp : null,
    in_clock: timeKey_(inEv.ts),
    out_clock: outEv ? timeKey_(outEv.ts) : null,
    minutes: minutes,
    flagged: !!(inEv.flagged || (outEv && outEv.flagged)),
    needs_review: status !== 'closed' && status !== 'open',
    sources: outEv ? [inEv.source, outEv.source] : [inEv.source],
    // 'rejected' if either end is rejected, 'recovered' if either was restored,
    // 'verified' only if both ends were. Every status change moves both ends
    // together, so a mixed pair means somebody edited the sheet by hand; the
    // stricter label wins.
    event_status: mergeStatus_(inEv.status, outEv ? outEv.status : null)
  };
}

function mergeStatus_(a, b) {
  var x = normStatus_(a), y = b == null ? x : normStatus_(b);
  if (x === STATUS_REJECTED || y === STATUS_REJECTED) return STATUS_REJECTED;
  if (x === STATUS_RECOVERED || y === STATUS_RECOVERED) return STATUS_RECOVERED;
  if (x === STATUS_VERIFIED && y === STATUS_VERIFIED) return STATUS_VERIFIED;
  return STATUS_ACTIVE;
}

/** Totals are ALWAYS computed here from the log — never stored anywhere. */
function summarize_(sessions) {
  var closedMinutes = 0, closedCount = 0, flagged = 0, review = 0, openSession = null;
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (s.status === 'closed') { closedMinutes += s.minutes; closedCount++; }
    if (s.status === 'open') openSession = s;
    if (s.flagged) flagged++;
    if (s.needs_review) review++;
  }
  return {
    total_minutes: closedMinutes,
    total_hours: Math.round(closedMinutes / 6) / 10,
    session_count: closedCount,
    flagged_sessions: flagged,
    sessions_needing_review: review,
    currently_in: !!openSession,
    current_session_minutes: openSession ? openSession.minutes : null,
    current_session_since: openSession ? openSession.in_time : null
  };
}

function eventRow_(ev) {
  return [ev.event_id, ev.student_id, ev.timestamp, ev.direction,
          ev.source, ev.flagged === true, ev.note || '', ev.status || STATUS_ACTIVE];
}

/**
 * Set Events.status on a set of rows, in one write.
 *
 * `updates` is [{_row, status}] using the 1-based sheet rows readTable_ hands
 * back. The whole status column is read, patched in memory and written once —
 * a getRange().setValue() per row would cost a round trip each and the nightly
 * job touches dozens at a time.
 *
 * Caller must hold the lock.
 */
function setEventStatuses_(updates) {
  if (!updates.length) return 0;
  var sh = sheet_(TAB_EVENTS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  var range = sh.getRange(2, COL_EVENT_STATUS, lastRow - 1, 1);
  var col = range.getValues();
  var changed = 0;
  for (var i = 0; i < updates.length; i++) {
    var idx = updates[i]._row - 2;                 // sheet row -> 0-based offset
    if (idx < 0 || idx >= col.length) continue;
    if (String(col[idx][0]).trim().toLowerCase() === updates[i].status) continue;
    col[idx][0] = updates[i].status;
    changed++;
  }
  if (!changed) return 0;
  range.setValues(col);
  invalidateTable_(TAB_EVENTS);                    // in place, so not via appendRows_
  return changed;
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

function studentIndex_(rows) {
  var by = {};
  for (var i = 0; i < rows.length; i++) {
    var sid = normId_(rows[i].student_id);
    if (!sid) continue;
    by[sid] = {
      student_id: sid,
      name: String(rows[i].name || '').trim(),
      grade: rows[i].grade === '' || rows[i].grade === null ? '' : String(rows[i].grade).trim(),
      active: truthy_(rows[i].active),
      created_at: rows[i].created_at instanceof Date ? toIso_(rows[i].created_at)
                                                     : String(rows[i].created_at || ''),
      email: String(rows[i].email || '').trim(),
      summary_token: String(rows[i].summary_token || '').trim(),
      team_id: String(rows[i].team_id || '').trim(),
      _row: rows[i]._row
    };
  }
  return by;
}

/**
 * The student record as the frontend sees it. summary_token is deliberately NOT
 * here: it is that student's private link, and the admin page has no use for it
 * that is worth putting every token on the wire on every roster load.
 */
function publicStudent_(s) {
  return { student_id: s.student_id, name: s.name, grade: s.grade,
           active: s.active, created_at: s.created_at, email: s.email || '',
           team_id: s.team_id || '' };
}

/**
 * Validate an optional email. Returns '' for "not given", which is a first
 * class answer — a student must be able to enroll in one tap without one.
 *
 * The check is deliberately loose. The only thing worth catching at the tablet
 * is a typo shaped like "sam@gmail" or a name typed into the wrong box; a
 * stricter pattern would reject valid addresses and strand a student at a
 * kiosk with no keyboard help and a line behind them.
 */
function normEmail_(v) {
  var e = String(v === null || v === undefined ? '' : v).trim();
  if (!e) return '';
  if (e.length > 120) fail_('that email address is too long');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) fail_('"' + e + '" does not look like an email address');
  return e;
}

/** A fresh URL-safe summary token: 32 hex characters from a v4 UUID. */
function newToken_() {
  return Utilities.getUuid().replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Teams
//
// A team is a coach-side grouping — Build, Programming, Business, whatever the
// season calls them — and nothing else in the app knows it exists. It is NOT
// attendance data: no event, hour, session or statistic changes when a student
// moves between teams, because Events keys off student_id alone and every total
// is recomputed from the log. Reassigning the whole roster the night before
// competition is free.
//
// Two decisions worth stating, because both are easy to get wrong later:
//
//   1. Students carry a team_id, not a team name. A team can therefore be
//      renamed by writing one cell, instead of rewriting every member's row and
//      hoping nothing crashed halfway through.
//   2. "Unassigned" is not a team. It is the absence of one — a blank team_id,
//      which is what every existing row already holds after the migration, and
//      what a student falls back to when their team is deleted. There is no
//      row for it and it can never be renamed or removed.
//
// The tablet never sees any of this. A student in a queue is not asked which
// subteam they are on.
// ---------------------------------------------------------------------------

/** Read the Teams tab, tolerating a deployment that has not been migrated. */
function readTeams_() {
  if (!ss_().getSheetByName(TAB_TEAMS)) return [];
  return readTable_(TAB_TEAMS);
}

function teamIndex_(rows) {
  var by = {};
  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i].team_id || '').trim();
    if (!id) continue;
    by[id] = {
      team_id: id,
      name: String(rows[i].name || '').trim(),
      created_at: rows[i].created_at instanceof Date ? toIso_(rows[i].created_at)
                                                     : String(rows[i].created_at || ''),
      _row: rows[i]._row
    };
  }
  return by;
}

/** The team list as the admin page sees it, alphabetical. */
function publicTeams_() {
  var index = teamIndex_(readTeams_());
  var out = [];
  for (var id in index) {
    if (!index.hasOwnProperty(id)) continue;
    out.push({ team_id: index[id].team_id, name: index[id].name,
               created_at: index[id].created_at });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

function normTeamName_(v) {
  var name = String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ');
  if (!name) fail_('a team needs a name');
  if (name.length > 60) fail_('that team name is too long (max 60 characters)');
  return name;
}

/**
 * Refuse a second team with the same name. Case- and space-insensitive: two
 * teams a coach cannot tell apart in a dropdown are a bug, not a feature.
 */
function assertTeamNameFree_(index, name, exceptId) {
  var wanted = name.toLowerCase();
  for (var id in index) {
    if (!index.hasOwnProperty(id)) continue;
    if (id === exceptId) continue;
    if (index[id].name.toLowerCase() === wanted) fail_('there is already a team called "' + index[id].name + '"');
  }
}

function newTeamId_() {
  return 'tm_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/**
 * Write the team_id column for a set of students in ONE setValues() call.
 *
 * `assignments` maps student_id to the team_id it should end up with. Reading
 * and rewriting the whole column costs two round trips no matter how many
 * students moved, where a loop of setValue() costs two per student — and this
 * is the path a "move nine people onto Build" click takes.
 *
 * Caller must hold the lock. Returns the number of cells that actually changed.
 */
function writeStudentTeams_(students, assignments) {
  var sh = sheet_(TAB_STUDENTS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  var range = sh.getRange(2, COL_STUDENT_TEAM, lastRow - 1, 1);
  var column = range.getValues();
  var changed = 0;
  for (var sid in assignments) {
    if (!assignments.hasOwnProperty(sid)) continue;
    var student = students[sid];
    if (!student) continue;
    var index = student._row - 2;          // the column starts at sheet row 2
    if (index < 0 || index >= column.length) continue;
    var wanted = assignments[sid];
    if (String(column[index][0] || '').trim() === wanted) continue;
    column[index][0] = wanted;
    student.team_id = wanted;
    changed++;
  }
  if (changed) {
    range.setValues(column);
    invalidateTable_(TAB_STUDENTS);        // in place, so not via appendRows_
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Actions: teams
// ---------------------------------------------------------------------------

/** The team list, with how many students are on each. */
function actionGetTeams_(p) {
  requirePin_(p);
  var teams = publicTeams_();
  var students = studentIndex_(readTable_(TAB_STUDENTS));

  var counts = {};
  var unassigned = 0;
  for (var sid in students) {
    if (!students.hasOwnProperty(sid)) continue;
    var tid = students[sid].team_id;
    if (tid) counts[tid] = (counts[tid] || 0) + 1;
    else unassigned++;
  }
  for (var i = 0; i < teams.length; i++) {
    teams[i].member_count = counts[teams[i].team_id] || 0;
  }
  return ok_({ teams: teams, unassigned_count: unassigned, generated_at: nowIso_() });
}

function actionCreateTeam_(p) {
  requirePin_(p);
  var name = normTeamName_(p.name);

  return withLock_(function () {
    var index = teamIndex_(readTeams_());
    assertTeamNameFree_(index, name, null);
    var team = { team_id: newTeamId_(), name: name, created_at: nowIso_() };
    appendRows_(TAB_TEAMS, [[team.team_id, team.name, team.created_at]]);
    return ok_({ team: team, teams: publicTeams_() });
  });
}

/**
 * Rename a team. One cell. Members carry the id, not the name, so nobody moves
 * and no total changes.
 */
function actionRenameTeam_(p) {
  requirePin_(p);
  var teamId = String(p.team_id || '').trim();
  if (!teamId) fail_('renameTeam needs a team_id');
  var name = normTeamName_(p.name);

  return withLock_(function () {
    var index = teamIndex_(readTeams_());
    var team = index[teamId];
    if (!team) fail_('no team with id ' + teamId);
    assertTeamNameFree_(index, name, teamId);

    var previous = team.name;
    if (name !== previous) {
      sheet_(TAB_TEAMS).getRange(team._row, COL_TEAM_NAME).setValue(name);
      invalidateTable_(TAB_TEAMS);         // in place, so not via appendRows_
      team.name = name;
    }
    return ok_({ team: { team_id: teamId, name: name, created_at: team.created_at },
                 previous_name: previous, changed: name !== previous,
                 teams: publicTeams_() });
  });
}

/**
 * Delete a team and return its members to Unassigned.
 *
 * This is the one place in the whole backend that deletes a row, and it is safe
 * to: a team holds no history. Nothing references it but the team_id column on
 * the roster, which is cleared here in the same lock, so there is no window
 * where a student points at a team that is gone.
 */
function actionDeleteTeam_(p) {
  requirePin_(p);
  var teamId = String(p.team_id || '').trim();
  if (!teamId) fail_('deleteTeam needs a team_id');

  return withLock_(function () {
    var index = teamIndex_(readTeams_());
    var team = index[teamId];
    if (!team) fail_('no team with id ' + teamId);

    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var assignments = {};
    for (var sid in students) {
      if (!students.hasOwnProperty(sid)) continue;
      if (students[sid].team_id === teamId) assignments[sid] = '';
    }
    var unassigned = writeStudentTeams_(students, assignments);

    sheet_(TAB_TEAMS).deleteRow(team._row);
    invalidateTable_(TAB_TEAMS);

    return ok_({ team_id: teamId, name: team.name, unassigned: unassigned,
                 teams: publicTeams_() });
  });
}

/**
 * Put students on a team, or take them off it.
 *
 * Takes `student_id` or a `student_ids` array — a coach assigning a subteam
 * ticks eight names and saves once, and that must be one request and one column
 * write, not eight of each. An empty team_id means Unassigned, which is a
 * normal answer and not an error.
 */
function actionSetTeam_(p) {
  requirePin_(p);
  var raw = p.student_ids || p.studentIds ||
            (p.student_id === undefined ? null : [p.student_id]);
  if (!(raw instanceof Array) || !raw.length) fail_('setTeam needs student_id or a non-empty student_ids array');
  if (raw.length > 500) fail_('too many students in one request (max 500)');

  var ids = [];
  for (var i = 0; i < raw.length; i++) ids.push(requireId_(raw[i]));
  var teamId = String(p.team_id || '').trim();

  return withLock_(function () {
    if (teamId) {
      var teams = teamIndex_(readTeams_());
      if (!teams[teamId]) fail_('no team with id ' + teamId);
    }
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var assignments = {};
    for (var j = 0; j < ids.length; j++) {
      if (!students[ids[j]]) fail_('no student with id ' + ids[j]);
      assignments[ids[j]] = teamId;
    }
    var changed = writeStudentTeams_(students, assignments);

    var updated = [];
    for (var k = 0; k < ids.length; k++) updated.push(publicStudent_(students[ids[k]]));
    return ok_({ team_id: teamId, changed: changed, students: updated });
  });
}

// ---------------------------------------------------------------------------
// Action: scan
// ---------------------------------------------------------------------------

/**
 * A student tapped their card on the tablet.
 *
 * Everything — the roster lookup, the debounce check, the last-event lookup and
 * the append — happens inside one lock. If the debounce ran outside it, two
 * tablets reading the same "last event" a millisecond apart would both decide
 * to append and the student would be scanned twice.
 *
 * Returns one of:
 *   {status:"unknown"}    ID not on the roster; the tablet offers enrollment
 *   {status:"inactive"}   on the roster but archived
 *   {status:"debounced"}  scanned again within the debounce window; nothing written
 *   {status:"ok"}         event appended; carries name, direction, duration
 */
function actionScan_(p) {
  var studentId = requireId_(p.student_id);
  var source = String(p.source || SOURCE_TABLET).trim() || SOURCE_TABLET;

  // Filled in by the locked section when the scan closed a session and the
  // student has an email. Queued AFTER the lock is released and never awaited:
  // a student is standing at the tablet, and mail delivery is not their problem.
  var mail = null;

  var response = withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var student = students[studentId];
    if (!student) return ok_({ status: 'unknown', student_id: studentId });
    if (!student.active) {
      return ok_({ status: 'inactive', student_id: studentId, name: student.name });
    }

    var mine = groupByStudent_(resolveEvents_(readTable_(TAB_EVENTS)))[studentId] || [];
    var last = mine.length ? mine[mine.length - 1] : null;
    var now = new Date();

    var debounceSec = cfgNum_('scan_debounce_seconds', 15);
    if (last && (now.getTime() - last.ts.getTime()) < debounceSec * 1000) {
      // Double-read of the same card, or a student handing the card to a friend
      // too fast. Say so and write nothing.
      return ok_({
        status: 'debounced',
        student_id: studentId,
        name: student.name,
        direction: last.direction,
        seconds_ago: Math.round((now.getTime() - last.ts.getTime()) / 1000)
      });
    }

    // Presence is derived from the log, never from a stored flag.
    var direction = (last && last.direction === DIR_IN) ? DIR_OUT : DIR_IN;

    var ev = {
      event_id: newId_('evt'),
      student_id: studentId,
      timestamp: toIso_(now),          // server clock, always
      direction: direction,
      source: source,
      flagged: false,
      note: ''
    };
    appendRows_(TAB_EVENTS, [eventRow_(ev)]);

    var durationMinutes = null;
    if (direction === DIR_OUT && last) durationMinutes = Math.max(0, minutesBetween_(last.ts, now));

    if (direction === DIR_OUT && student.email && student.summary_token) {
      mail = {
        to: student.email,
        name: student.name,
        token: student.summary_token,
        date: dateKey_(now),
        minutes: durationMinutes,
        in_time: last ? last.timestamp : null,
        out_time: ev.timestamp
      };
    }

    return ok_({
      status: 'ok',
      student_id: studentId,
      name: student.name,
      direction: direction,
      event_id: ev.event_id,
      timestamp: ev.timestamp,
      clock: timeKey_(now),
      duration_minutes: durationMinutes,
      session_start: direction === DIR_OUT && last ? last.timestamp : null
    });
  });

  if (mail) queueSummaryEmail_(mail);
  return response;
}

// ---------------------------------------------------------------------------
// Action: enroll
// ---------------------------------------------------------------------------

/** Add a student to the roster. Called from the tablet after an unknown scan. */
function actionEnroll_(p) {
  var studentId = requireId_(p.student_id);
  var name = requireStr_(p, 'name', 80);
  var grade = p.grade === undefined || p.grade === null ? '' : String(p.grade).trim();
  // Optional by design: the tablet's email field has a Skip button, and a
  // student who skips it enrolls in one tap. An empty email is not an error.
  var email = normEmail_(p.email);

  return withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    if (students[studentId]) {
      fail_('student_id ' + studentId + ' is already enrolled as ' + students[studentId].name);
    }
    var created = nowIso_();
    // Every student gets a summary token at enrollment, email or not. A student
    // who adds an email in March should not need a second migration pass to get
    // a working link, and a coach can hand out the link by any other route.
    var token = newToken_();
    // team_id is blank at enrollment: teams are an admin-side grouping, and the
    // tablet must never ask a student in a queue which subteam they are on.
    appendRows_(TAB_STUDENTS, [[studentId, name, grade, true, created, email, token, '']]);
    return ok_({
      student_id: studentId, name: name, grade: grade, active: true,
      created_at: created, email: email
    });
  });
}

// ---------------------------------------------------------------------------
// Action: syncQueue
// ---------------------------------------------------------------------------

/**
 * Replay scans the tablet captured while offline.
 *
 * These are the one case where a client timestamp is written, so every row here
 * gets flagged = true and source = "offline" — the admin UI shows them as
 * unverified. Replay is idempotent: a retry after a dropped response will not
 * duplicate rows, because we skip any queued scan whose
 * student/second/direction already exists in the raw sheet (raw, not resolved,
 * so a scan an admin already voided does not come back from the dead).
 *
 * Direction comes from the tablet when the queue recorded one — that is what
 * the student was actually told at the door, and rewriting it would falsify
 * their evening. When the queue has no direction, it is derived by merging the
 * scan into the student's existing timeline and taking the opposite of whatever
 * precedes it.
 */
function actionSyncQueue_(p) {
  var queue = p.scans || p.queue || p.events;
  if (!queue || !queue.length) fail_('syncQueue needs a non-empty scans array');
  if (queue.length > 500) fail_('too many queued scans in one request (max 500)');

  return withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var rawRows = readTable_(TAB_EVENTS);
    var existing = resolveEvents_(rawRows);
    var byStudent = groupByStudent_(existing);

    // Dedupe index over the RAW sheet, keyed to the second.
    var seen = {};
    for (var r = 0; r < rawRows.length; r++) {
      var raw = toEvent_(rawRows[r]);
      if (raw) seen[dedupeKey_(raw.student_id, raw.ts, raw.direction)] = true;
    }

    var accepted = [];
    var rejected = [];
    var duplicates = 0;
    var now = new Date();

    for (var i = 0; i < queue.length; i++) {
      var q = queue[i] || {};
      var sid = normId_(q.student_id);
      if (!/^\d{7}$/.test(sid)) { rejected.push({ index: i, reason: 'bad student_id' }); continue; }
      if (!students[sid])       { rejected.push({ index: i, student_id: sid, reason: 'not on roster' }); continue; }
      var ts = parseTs_(q.timestamp);
      if (!ts)                  { rejected.push({ index: i, student_id: sid, reason: 'unparseable timestamp' }); continue; }
      var dir = String(q.direction || '').trim().toLowerCase();
      accepted.push({
        index: i,
        student_id: sid,
        ts: ts,
        claimed: (dir === DIR_IN || dir === DIR_OUT) ? dir : null,
        ahead: ts.getTime() > now.getTime() + 60000    // tablet clock running fast
      });
    }

    // Merge each student's queued scans into their timeline, then walk it in
    // order so directions alternate correctly even for out-of-order arrivals.
    var pending = {};
    for (var a = 0; a < accepted.length; a++) {
      var sidA = accepted[a].student_id;
      if (!pending[sidA]) pending[sidA] = [];
      pending[sidA].push(accepted[a]);
    }

    var rows = [];
    var written = [];
    for (var sid2 in pending) {
      if (!pending.hasOwnProperty(sid2)) continue;
      var timeline = (byStudent[sid2] || []).slice();
      var queued = pending[sid2].slice().sort(function (x, y) { return x.ts.getTime() - y.ts.getTime(); });

      for (var k = 0; k < queued.length; k++) {
        var item = queued[k];
        var prev = lastBefore_(timeline, item.ts);
        var derived = (prev && prev.direction === DIR_IN) ? DIR_OUT : DIR_IN;
        var direction = item.claimed || derived;

        var key = dedupeKey_(sid2, item.ts, direction);
        if (seen[key]) { duplicates++; continue; }
        seen[key] = true;

        var notes = ['offline replay'];
        if (item.claimed && item.claimed !== derived) {
          // Another tablet was online and logged this student in between. Write
          // what the offline tablet recorded and say so; buildSessions_ shows
          // the result as needs_review rather than quietly picking a winner.
          notes.push('tablet recorded "' + item.claimed + '", timeline implies "' + derived + '"');
        }
        if (item.ahead) notes.push('client clock ahead of server');

        var ev = {
          event_id: newId_('evt'),
          student_id: sid2,
          timestamp: toIso_(item.ts),    // CLIENT timestamp — hence flagged below
          direction: direction,
          source: SOURCE_OFFLINE,
          flagged: true,                 // unverified clock; never write these unflagged
          note: notes.join('; ')
        };
        rows.push(eventRow_(ev));
        written.push({ index: item.index, event_id: ev.event_id, student_id: sid2,
                       direction: direction, timestamp: ev.timestamp });
        timeline.push({ ts: item.ts, direction: direction, event_id: ev.event_id, student_id: sid2 });
        timeline = sortByTs_(timeline);
      }
    }

    appendRows_(TAB_EVENTS, rows);
    return ok_({
      received: queue.length,
      written: rows.length,
      skipped_duplicates: duplicates,
      rejected: rejected,
      events: written
    });
  });
}

function dedupeKey_(studentId, ts, direction) {
  return studentId + '|' + Math.floor(ts.getTime() / 1000) + '|' + direction;
}

/** Latest event strictly before ts, in an ascending-sorted list. */
function lastBefore_(sortedEvents, ts) {
  var found = null;
  for (var i = 0; i < sortedEvents.length; i++) {
    if (sortedEvents[i].ts.getTime() < ts.getTime()) found = sortedEvents[i];
    else break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Action: lookupStudent
// ---------------------------------------------------------------------------

/**
 * Confirm an ID belongs to somebody, and describe their lab time on one day.
 *
 * The summary page needs this before a student writes anything: it shows the
 * name back so they know they typed the right number, and it prefills the
 * session they are writing about.
 *
 * Deliberately unauthenticated, like `scan` and `enroll`. It exposes no more
 * than `scan` already does — a name for an ID you had to know, plus that day's
 * in/out times — and unlike `scan` it writes nothing at all, so pointing the
 * summary page at it can never create attendance. It returns ONLY the requested
 * day: no history, no totals, no roster listing.
 */
function actionLookupStudent_(p) {
  var studentId = requireId_(p.student_id);
  var date = String(p.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_('date must be YYYY-MM-DD');

  var student = studentIndex_(readTable_(TAB_STUDENTS))[studentId];
  if (!student) return ok_({ found: false, student_id: studentId });

  var out = {
    found: true,
    student_id: studentId,
    name: student.name,
    grade: student.grade,
    active: student.active
  };

  if (date) {
    var day = studentDay_(studentId, date);
    out.date = date;
    out.sessions = day.sessions;
    out.summaries_on_date = day.summaries_on_date;
  }

  return ok_(out);
}

/**
 * Resolve a summary link token to the student who owns it.
 *
 * This is what makes ?t=<token> work: the student clicks the link in their
 * scan-out email and lands on a page that already knows who they are, with no
 * ID to type and no camera to open.
 *
 * It deliberately does NOT return student_id. The whole reason the link carries
 * a token instead of an ID is that a 7-digit ID is a credential — it is what
 * `scan` and `enroll` accept — and a link that is forwarded, screenshotted or
 * left in a browser history should not hand one out. submitSummary accepts the
 * token in its place, so the page never needs the number.
 *
 * Unauthenticated, like lookupStudent, but strictly narrower: it takes a
 * 32-character random token nobody can guess, and it writes nothing.
 */
function actionLookupToken_(p) {
  var token = String(p.t || p.token || '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return ok_({ found: false });

  var student = studentByToken_(readTable_(TAB_STUDENTS), token);
  if (!student) return ok_({ found: false });

  var date = String(p.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_('date must be YYYY-MM-DD');

  var out = { found: true, name: student.name, grade: student.grade, active: student.active };
  if (date) {
    var day = studentDay_(student.student_id, date);
    out.date = date;
    out.sessions = day.sessions;
    out.summaries_on_date = day.summaries_on_date;
  }
  return ok_(out);
}

/** Constant-ish token lookup. Tokens are unique; the first match wins. */
function studentByToken_(rows, token) {
  var students = studentIndex_(rows);
  for (var sid in students) {
    if (!students.hasOwnProperty(sid)) continue;
    if (students[sid].summary_token && students[sid].summary_token === token) return students[sid];
  }
  return null;
}

/** One student's sessions and summary count on one local day. */
function studentDay_(studentId, date) {
  var events = groupByStudent_(resolveEvents_(readTable_(TAB_EVENTS)))[studentId] || [];
  var all = buildSessions_(events);
  var sessions = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].date !== date) continue;
    sessions.push({
      status: all[i].status,
      in_time: all[i].in_time,
      out_time: all[i].out_time,
      in_clock: all[i].in_clock,
      out_clock: all[i].out_clock,
      minutes: all[i].minutes,
      flagged: all[i].flagged
    });
  }
  var summaries = resolveSummaries_(readTable_(TAB_SUMMARIES));
  var already = 0;
  for (var s = 0; s < summaries.length; s++) {
    if (normId_(summaries[s].student_id) !== studentId) continue;
    if (summaryDate_(summaries[s]) === date) already++;
  }
  return { sessions: sessions, summaries_on_date: already };
}

/**
 * Summaries with voided ones removed.
 *
 * Same append-only shape as the event log: deleting a summary appends a
 * tombstone whose text is "void:<summary_id> — reason", and both rows drop out
 * here while staying in the sheet for the record.
 */
function resolveSummaries_(rows) {
  var dropped = {};
  var kept = [];
  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i].summary_id || '').trim();
    if (!id) continue;
    var m = /^void:(\S+)/.exec(String(rows[i].text || '').trim());
    if (m) {
      dropped[m[1]] = true;
      dropped[id] = true;          // the tombstone is not itself a summary
    }
    kept.push(rows[i]);
  }
  var out = [];
  for (var j = 0; j < kept.length; j++) {
    if (!dropped[String(kept[j].summary_id).trim()]) out.push(kept[j]);
  }
  return out;
}

/** session_date can come back as text or as a Date, depending on the cell. */
function summaryDate_(row) {
  return row.session_date instanceof Date
    ? dateKey_(row.session_date)
    : String(row.session_date || '').trim();
}

// ---------------------------------------------------------------------------
// Action: submitSummary
// ---------------------------------------------------------------------------

/**
 * A student submits what they worked on, with photos, from their phone.
 *
 * Photos go to Drive BEFORE the lock is taken. An upload can take several
 * seconds and the lock is shared with the scanner — holding it through a Drive
 * round-trip would stall the tablet at the door.
 */
function actionSubmitSummary_(p) {
  // Either identifier works. A student who followed their emailed link sends a
  // token and never learns their own ID; one who scanned or typed it in sends
  // the ID, exactly as before.
  var token = String(p.token || p.t || '').trim();
  var studentId;
  if (token) {
    var byToken = studentByToken_(readTable_(TAB_STUDENTS), token);
    if (!byToken) fail_('that summary link is not valid — ask a coach for a new one');
    studentId = byToken.student_id;
  } else {
    studentId = requireId_(p.student_id);
  }
  var text = requireStr_(p, 'text', MAX_SUMMARY_CHARS);
  var photos = p.photos || [];
  if (!(photos instanceof Array)) fail_('photos must be an array');
  if (photos.length > MAX_PHOTOS) fail_('too many photos (max ' + MAX_PHOTOS + ')');

  var students = studentIndex_(readTable_(TAB_STUDENTS));
  var student = students[studentId];
  if (!student) fail_('student_id ' + studentId + ' is not on the roster');
  if (!student.active) fail_(student.name + ' is archived and cannot submit summaries');

  var sessionDate = String(p.session_date || '').trim();
  if (sessionDate && !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) fail_('session_date must be YYYY-MM-DD');
  if (!sessionDate) sessionDate = dateKey_(new Date());

  // --- Drive uploads, outside the lock ---
  var urls = [];
  if (photos.length) {
    var folder = summariesFolder_();
    for (var i = 0; i < photos.length; i++) {
      var blob = decodePhoto_(photos[i], studentId, sessionDate, i);
      var file = folder.createFile(blob);
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        // Some Workspace domains forbid link sharing. The file is still saved;
        // the admin will see it when signed in to the account that owns it.
        console.warn('could not set link sharing on ' + file.getId() + ': ' + shareErr);
      }
      urls.push('https://drive.google.com/uc?export=view&id=' + file.getId());
    }
  }

  // --- Sheet write, inside the lock ---
  return withLock_(function () {
    var row = {
      summary_id: newId_('sum'),
      submitted_at: nowIso_()          // server clock
    };
    appendRows_(TAB_SUMMARIES, [[
      row.summary_id, studentId, sessionDate, text, urls.join(', '), row.submitted_at
    ]]);

    // A late summary heals its own rejection. The nightly job rejected these
    // for the absence of exactly the row we just wrote, so waiting for the next
    // run — or for a coach to notice — would leave a student staring at hours
    // marked rejected minutes after they did the thing that fixes it.
    var recovered = recoverRejectedFor_(studentId, sessionDate);

    return ok_({
      summary_id: row.summary_id,
      student_id: studentId,
      name: student.name,
      session_date: sessionDate,
      photo_urls: urls,
      submitted_at: row.submitted_at,
      recovered_sessions: recovered.sessions,
      recovered_minutes: recovered.minutes
    });
  });
}

/**
 * Accepts either a bare base64 string, a data: URL, or
 * {name, mimeType, data}. Returns a Drive-ready blob.
 */
function decodePhoto_(item, studentId, sessionDate, index) {
  var data, mime = 'image/jpeg', name = '';
  if (typeof item === 'string') {
    data = item;
  } else if (item && typeof item === 'object') {
    data = item.data || item.base64 || '';
    mime = String(item.mimeType || item.type || mime);
    name = String(item.name || '');
  } else {
    fail_('photo ' + (index + 1) + ' is not a string or object');
  }

  var m = /^data:([^;,]+);base64,(.*)$/.exec(String(data));
  if (m) { mime = m[1]; data = m[2]; }
  data = String(data).replace(/\s+/g, '');
  if (!data) fail_('photo ' + (index + 1) + ' is empty');
  if (!/^image\//.test(mime)) fail_('photo ' + (index + 1) + ' is not an image (' + mime + ')');

  var bytes;
  try {
    bytes = Utilities.base64Decode(data);
  } catch (decodeErr) {
    fail_('photo ' + (index + 1) + ' is not valid base64');
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    fail_('photo ' + (index + 1) + ' is too large (' + Math.round(bytes.length / 1048576) +
          ' MB, max ' + Math.round(MAX_PHOTO_BYTES / 1048576) + ' MB) — resize it on the phone first');
  }
  if (!name) {
    name = sessionDate + '_' + studentId + '_' + (index + 1) + extForMime_(mime);
  }
  return Utilities.newBlob(bytes, mime, name);
}

function extForMime_(mime) {
  if (/png/i.test(mime)) return '.png';
  if (/webp/i.test(mime)) return '.webp';
  if (/heic|heif/i.test(mime)) return '.heic';
  if (/gif/i.test(mime)) return '.gif';
  return '.jpg';
}

/**
 * Flip every rejected event of one student on one local day back to recovered.
 *
 * Caller must hold the lock. Returns what it changed so the response can say so.
 */
function recoverRejectedFor_(studentId, date) {
  var raw = readTable_(TAB_EVENTS);
  var rowOf = rawRowIndex_(raw);
  var all = buildSessions_(groupByStudent_(resolveEvents_(raw, true))[studentId] || []);

  var updates = [];
  var count = 0;
  var minutes = 0;
  for (var i = 0; i < all.length; i++) {
    var sess = all[i];
    if (sess.date !== date || sess.event_status !== STATUS_REJECTED) continue;
    var ids = [sess.in_event_id, sess.out_event_id];
    for (var k = 0; k < ids.length; k++) {
      if (ids[k] && rowOf[ids[k]]) updates.push({ _row: rowOf[ids[k]], status: STATUS_RECOVERED });
    }
    count++;
    if (typeof sess.minutes === 'number') minutes += sess.minutes;
  }
  setEventStatuses_(updates);
  return { sessions: count, minutes: minutes };
}

/** event_id -> the 1-based sheet row it lives on, for in-place status writes. */
function rawRowIndex_(rawRows) {
  var by = {};
  for (var i = 0; i < rawRows.length; i++) {
    var id = String(rawRows[i].event_id || '').trim();
    if (id) by[id] = rawRows[i]._row;
  }
  return by;
}

/** The Drive folder from Config, falling back to a lookup and finally a create. */
function summariesFolder_() {
  var id = cfgStr_('drive_folder_id', '');
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (e) { console.warn('Config drive_folder_id ' + id + ' is unreachable: ' + e); }
  }
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  fail_('Drive folder is not set up — run initializeSheets() once from the editor');
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

/**
 * The PIN travels in the JSON body, not in a header — an Authorization header
 * would trigger the CORS preflight that Apps Script cannot answer. See the note
 * at the top of this file.
 *
 * This is a shared PIN on a class roster, not real authentication. It keeps
 * students out of the admin page; it is not a secret worth defending against
 * anyone determined. Never return the PIN in a response.
 */
function requirePin_(p) {
  var expected = cfgStr_('admin_pin', '');
  if (!expected) fail_('admin PIN is not configured — set admin_pin in the Config tab');
  var given = String(p.pin === undefined || p.pin === null ? '' : p.pin).trim();
  if (given !== String(expected)) {
    Utilities.sleep(500);            // token slowdown against guessing a 6-digit PIN
    fail_('incorrect PIN');
  }
}

/** Roster with per-student totals, all recomputed from the log. */
function actionGetRoster_(p) {
  requirePin_(p);
  var includeInactive = p.include_inactive === undefined ? true : truthy_(p.include_inactive);

  // The admin page needs four columns — id, name, grade, active — and derives
  // every statistic from the timesheet it fetches anyway. Saying so lets us
  // skip reading Events, resolving them and building every student's sessions
  // for a payload that would be thrown away. The tablet's roster prime still
  // wants currently_in, so it does not pass this and gets the full shape.
  var slim = truthy_(p.slim);

  var students = studentIndex_(readTable_(TAB_STUDENTS));
  var byStudent = slim ? null : groupByStudent_(resolveEvents_(readTable_(TAB_EVENTS)));

  var roster = [];
  var inLab = 0;
  for (var sid in students) {
    if (!students.hasOwnProperty(sid)) continue;
    var s = students[sid];
    if (!s.active && !includeInactive) continue;
    // Five columns in slim mode: created_at is on the record but no view has
    // ever drawn it, and summary_token is private to the student. email IS
    // here — the admin roster shows and edits it, and a second round trip to
    // fetch one short string per student would be silly.
    var entry = slim
      ? { student_id: s.student_id, name: s.name, grade: s.grade,
          active: s.active, email: s.email, team_id: s.team_id || '' }
      : publicStudent_(s);
    if (!slim) {
      var events = byStudent[sid] || [];
      var stats = summarize_(buildSessions_(events));
      if (s.active && stats.currently_in) inLab++;
      for (var k in stats) if (stats.hasOwnProperty(k)) entry[k] = stats[k];
    }
    roster.push(entry);
  }
  roster.sort(function (a, b) { return a.name.localeCompare(b.name); });

  return ok_({
    students: roster,
    count: roster.length,
    currently_in_lab: slim ? null : inLab,
    // Teams ride along on the roster rather than living behind their own
    // fetch: the admin page cannot draw a single row without both, the list is
    // a handful of short strings, and a second round trip to Apps Script for it
    // would cost more than the whole payload.
    teams: publicTeams_(),
    generated_at: nowIso_()
  });
}

/**
 * Sessions across the whole team, optionally narrowed by date range or student.
 * from/to are inclusive local calendar days, YYYY-MM-DD.
 */
function actionGetTimesheet_(p) {
  requirePin_(p);
  var from = String(p.from || '').trim();
  var to   = String(p.to || '').trim();
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) fail_('from must be YYYY-MM-DD');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail_('to must be YYYY-MM-DD');
  var onlyStudent = p.student_id ? requireId_(p.student_id) : null;
  // Opt-in, so an older deployed page that has not asked for it keeps getting
  // the full shape. The admin page asks.
  var slim = truthy_(p.slim);
  // Also opt-in. Rejected sessions are excluded from the log by resolveEvents_,
  // which is what makes every total correct by construction — so the Rejected
  // Hours view has to ask for them back explicitly. Each row carries
  // event_status, and everything summed below still skips the rejected ones.
  var includeRejected = truthy_(p.include_rejected);

  var students = studentIndex_(readTable_(TAB_STUDENTS));
  var byStudent = groupByStudent_(resolveEvents_(readTable_(TAB_EVENTS), includeRejected));

  var sessions = [];
  var totals = [];
  for (var sid in byStudent) {
    if (!byStudent.hasOwnProperty(sid)) continue;
    if (onlyStudent && sid !== onlyStudent) continue;
    var student = students[sid];
    var all = buildSessions_(byStudent[sid]);
    var inRange = [];
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (from && s.date < from) continue;
      if (to && s.date > to) continue;
      s.name = student ? student.name : '(not on roster)';
      if (slim) {
        // The admin timesheet renders in_time/out_time itself and reads grade
        // off the roster entry, so shipping a local-clock copy and a duplicate
        // grade on every one of a season's sessions is dead weight.
        delete s.in_clock;
        delete s.out_clock;
      } else {
        s.grade = student ? student.grade : '';
      }
      inRange.push(s);
      sessions.push(s);
    }
    if (inRange.length && !slim) {
      var stats = summarize_(countable_(inRange));
      totals.push({
        student_id: sid,
        name: student ? student.name : '(not on roster)',
        grade: student ? student.grade : '',
        active: student ? student.active : false,
        total_minutes: stats.total_minutes,
        total_hours: stats.total_hours,
        session_count: stats.session_count,
        flagged_sessions: stats.flagged_sessions,
        sessions_needing_review: stats.sessions_needing_review
      });
    }
  }

  sessions.sort(function (a, b) {
    return a.in_time < b.in_time ? 1 : (a.in_time > b.in_time ? -1 : 0);   // newest first
  });
  totals.sort(function (a, b) { return b.total_minutes - a.total_minutes; });

  var grandMinutes = 0, flagged = 0, review = 0, rejected = 0;
  for (var j = 0; j < sessions.length; j++) {
    if (sessions[j].event_status === STATUS_REJECTED) { rejected++; continue; }
    if (sessions[j].status === 'closed') grandMinutes += sessions[j].minutes;
    if (sessions[j].flagged) flagged++;
    if (sessions[j].needs_review) review++;
  }

  return ok_({
    from: from || null,
    to: to || null,
    sessions: sessions,
    // Recomputed client-side in slim mode — it is a group-by over rows the
    // client already has, not something worth a second copy on the wire.
    totals_by_student: slim ? [] : totals,
    total_minutes: grandMinutes,
    total_hours: Math.round(grandMinutes / 6) / 10,
    flagged_sessions: flagged,
    sessions_needing_review: review,
    rejected_sessions: rejected,
    includes_rejected: includeRejected,
    // So the Rejected Hours view can state the actual rule rather than a
    // number hard-coded in a second place that drifts from the Config tab.
    grace_period_hours: cfgNum_('grace_period_hours', 24),
    generated_at: nowIso_()
  });
}

/** Drop rejected sessions. The counterpart of the filter in resolveEvents_. */
function countable_(sessions) {
  var out = [];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].event_status !== STATUS_REJECTED) out.push(sessions[i]);
  }
  return out;
}

/** One student: profile, stats, sessions, raw event log, summaries. */
function actionGetStudent_(p) {
  requirePin_(p);
  var studentId = requireId_(p.student_id);

  var students = studentIndex_(readTable_(TAB_STUDENTS));
  var student = students[studentId];
  if (!student) fail_('no student with id ' + studentId);

  var events = groupByStudent_(resolveEvents_(readTable_(TAB_EVENTS)))[studentId] || [];
  var sessions = buildSessions_(events).reverse();     // newest first
  var stats = summarize_(sessions);

  var eventList = [];
  for (var i = events.length - 1; i >= 0; i--) {
    eventList.push({
      event_id: events[i].event_id, timestamp: events[i].timestamp,
      clock: timeKey_(events[i].ts), date: dateKey_(events[i].ts),
      direction: events[i].direction, source: events[i].source,
      flagged: events[i].flagged, note: events[i].note
    });
  }

  var summaries = [];
  var summaryRows = resolveSummaries_(readTable_(TAB_SUMMARIES));
  for (var s = 0; s < summaryRows.length; s++) {
    if (normId_(summaryRows[s].student_id) !== studentId) continue;
    summaries.push({
      summary_id: String(summaryRows[s].summary_id || ''),
      session_date: summaryDate_(summaryRows[s]),
      text: String(summaryRows[s].text || ''),
      photo_urls: splitUrls_(summaryRows[s].photo_urls),
      submitted_at: summaryRows[s].submitted_at instanceof Date
        ? toIso_(summaryRows[s].submitted_at) : String(summaryRows[s].submitted_at || '')
    });
  }
  summaries.sort(function (a, b) { return a.submitted_at < b.submitted_at ? 1 : -1; });

  var out = { student: publicStudent_(student), sessions: sessions,
              events: eventList, summaries: summaries, generated_at: nowIso_() };
  for (var k in stats) if (stats.hasOwnProperty(k)) out[k] = stats[k];
  return ok_(out);
}

/**
 * Correct an event — by APPENDING a replacement, never by editing the row.
 *
 * The new row carries note "supersedes:<event_id> — <reason>", which makes
 * resolveEvents_() drop the original from every computed stat while the
 * original stays in the sheet as an audit trail. The corrected timestamp comes
 * from a human, so the replacement is flagged = true like any unverified time.
 *
 * Takes event_id plus at least one of timestamp (ISO or YYYY-MM-DD HH:mm) and
 * direction, plus an optional reason.
 */
/**
 * One student's sessions, rebuilt from the log the caller already has in hand.
 *
 * editEvent and deleteEvent both append a row and then owe the admin page an
 * answer precise enough that it never has to re-fetch. Returning just the new
 * event would not be enough: superseding a check-in can re-pair the sessions
 * around it, and only the server knows how. So they hand back this student's
 * whole rebuilt timeline, computed in memory from `raw` plus the row just
 * written — no second sheet read, and no guessing on the client.
 */
function studentSessionsAfter_(raw, appended, studentId) {
  var live = resolveEvents_(raw.concat(appended));
  var mine = groupByStudent_(live)[studentId] || [];
  var sessions = buildSessions_(mine);
  var students = studentIndex_(readTable_(TAB_STUDENTS));
  var student = students[studentId];
  var name = student ? student.name : '(not on roster)';
  for (var i = 0; i < sessions.length; i++) {
    sessions[i].name = name;
    delete sessions[i].in_clock;    // matches the slim timesheet shape
    delete sessions[i].out_clock;
  }
  sessions.sort(function (a, b) {
    return a.in_time < b.in_time ? 1 : (a.in_time > b.in_time ? -1 : 0);   // newest first
  });
  return sessions;
}

function actionEditEvent_(p) {
  requirePin_(p);
  var targetId = requireStr_(p, 'event_id', 64);
  var newDirection = String(p.direction || '').trim().toLowerCase();
  var hasDirection = !!newDirection;
  if (hasDirection && newDirection !== DIR_IN && newDirection !== DIR_OUT) {
    fail_('direction must be "in" or "out"');
  }
  var newTs = p.timestamp ? parseTs_(p.timestamp) : null;
  if (p.timestamp && !newTs) fail_('could not parse timestamp "' + p.timestamp + '"');
  if (!hasDirection && !newTs) fail_('editEvent needs a new timestamp, a new direction, or both');
  var reason = String(p.reason || p.note || '').trim();

  return withLock_(function () {
    var raw = readTable_(TAB_EVENTS);
    var live = resolveEvents_(raw);
    var target = findEvent_(live, targetId);
    if (!target) {
      fail_(existsInRaw_(raw, targetId)
        ? 'event ' + targetId + ' has already been corrected or voided'
        : 'no event with id ' + targetId);
    }

    var ev = {
      event_id: newId_('evt'),
      student_id: target.student_id,
      timestamp: toIso_(newTs || target.ts),
      direction: hasDirection ? newDirection : target.direction,
      source: SOURCE_ADMIN,
      flagged: true,                      // hand-entered time: unverified by definition
      note: 'supersedes:' + targetId + (reason ? ' — ' + reason : '')
    };
    appendRows_(TAB_EVENTS, [eventRow_(ev)]);

    return ok_({
      corrected: { event_id: target.event_id, timestamp: target.timestamp, direction: target.direction },
      replacement: ev,
      student_id: target.student_id,
      // Everything the admin page needs to patch its state without re-reading.
      sessions: studentSessionsAfter_(raw, [ev], target.student_id)
    });
  });
}

/**
 * Remove an event from the record — again by APPENDING, not deleting.
 *
 * Writes a tombstone row with direction "void" and note "void:<event_id>".
 * resolveEvents_() then drops both the tombstone and its target, so the event
 * stops counting while both rows remain in the sheet forever.
 */
function actionDeleteEvent_(p) {
  requirePin_(p);
  var targetId = requireStr_(p, 'event_id', 64);
  var reason = String(p.reason || p.note || '').trim();

  return withLock_(function () {
    var raw = readTable_(TAB_EVENTS);
    var live = resolveEvents_(raw);
    var target = findEvent_(live, targetId);
    if (!target) {
      fail_(existsInRaw_(raw, targetId)
        ? 'event ' + targetId + ' has already been corrected or voided'
        : 'no event with id ' + targetId);
    }

    var ev = {
      event_id: newId_('void'),
      student_id: target.student_id,
      timestamp: nowIso_(),               // when the void was recorded, server clock
      direction: DIR_VOID,
      source: SOURCE_ADMIN,
      flagged: true,
      note: 'void:' + targetId + (reason ? ' — ' + reason : '')
    };
    appendRows_(TAB_EVENTS, [eventRow_(ev)]);

    return ok_({
      voided: { event_id: target.event_id, timestamp: target.timestamp, direction: target.direction },
      tombstone_id: ev.event_id,
      student_id: target.student_id,
      sessions: studentSessionsAfter_(raw, [ev], target.student_id)
    });
  });
}

/**
 * Every summary, for the admin page. Fetched once at unlock alongside the
 * roster and the timesheet, so opening a student's detail view needs no
 * further request.
 */
function actionGetSummaries_(p) {
  requirePin_(p);
  var studentId = p.student_id ? requireId_(p.student_id) : null;
  var rows = resolveSummaries_(readTable_(TAB_SUMMARIES));
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var sid = normId_(rows[i].student_id);
    if (!sid) continue;
    if (studentId && sid !== studentId) continue;
    out.push({
      summary_id: String(rows[i].summary_id || ''),
      student_id: sid,
      session_date: summaryDate_(rows[i]),
      text: String(rows[i].text || ''),
      photo_urls: splitUrls_(rows[i].photo_urls),
      submitted_at: rows[i].submitted_at instanceof Date
        ? toIso_(rows[i].submitted_at) : String(rows[i].submitted_at || '')
    });
  }
  out.sort(function (a, b) { return a.submitted_at < b.submitted_at ? 1 : -1; });
  return ok_({ summaries: out, count: out.length, generated_at: nowIso_() });
}

/**
 * Remove a summary — by appending a tombstone, never by editing the sheet.
 *
 * This is the coach's only recourse when something inappropriate is posted, and
 * since anyone with the URL can submit a summary under any ID, it needs to be
 * genuinely effective: the photos are moved to the Drive trash too. Trash, not
 * a permanent delete, so a mistake is recoverable for 30 days.
 */
function actionDeleteSummary_(p) {
  requirePin_(p);
  var summaryId = requireStr_(p, 'summary_id', 64);
  var reason = String(p.reason || p.note || '').trim();
  var trashPhotos = p.trash_photos === undefined ? true : truthy_(p.trash_photos);

  return withLock_(function () {
    var rows = readTable_(TAB_SUMMARIES);
    var live = resolveSummaries_(rows);
    var target = null;
    for (var i = 0; i < live.length; i++) {
      if (String(live[i].summary_id).trim() === summaryId) { target = live[i]; break; }
    }
    if (!target) {
      var existed = false;
      for (var j = 0; j < rows.length; j++) {
        if (String(rows[j].summary_id).trim() === summaryId) existed = true;
      }
      fail_(existed ? 'summary ' + summaryId + ' has already been deleted'
                    : 'no summary with id ' + summaryId);
    }

    var urls = splitUrls_(target.photo_urls);
    var trashed = [];
    if (trashPhotos) {
      for (var u = 0; u < urls.length; u++) {
        var id = driveIdFromUrl_(urls[u]);
        if (!id) continue;
        try {
          DriveApp.getFileById(id).setTrashed(true);
          trashed.push(id);
        } catch (err) {
          console.warn('could not trash ' + id + ': ' + err);
        }
      }
    }

    appendRows_(TAB_SUMMARIES, [[
      newId_('void'),
      normId_(target.student_id),
      summaryDate_(target),
      'void:' + summaryId + (reason ? ' — ' + reason : ''),
      '',
      nowIso_()
    ]]);

    return ok_({
      deleted: summaryId,
      student_id: normId_(target.student_id),
      session_date: summaryDate_(target),
      photos_trashed: trashed.length,
      photos_total: urls.length
    });
  });
}

/** Pull the Drive file id out of whichever URL shape we stored. */
function driveIdFromUrl_(url) {
  var m = /[?&]id=([A-Za-z0-9_-]+)/.exec(url) || /\/d\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? m[1] : null;
}

function splitUrls_(value) {
  var parts = String(value || '').split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].trim()) out.push(parts[i].trim());
  }
  return out;
}

function findEvent_(events, eventId) {
  for (var i = 0; i < events.length; i++) if (events[i].event_id === eventId) return events[i];
  return null;
}

function existsInRaw_(rawRows, eventId) {
  for (var i = 0; i < rawRows.length; i++) {
    if (String(rawRows[i].event_id || '').trim() === eventId) return true;
  }
  return false;
}

/**
 * Archive or restore a student. This is the one mutable cell in the schema:
 * Students.active is a roster flag, not attendance data. History is untouched —
 * an archived student keeps every event and every hour they ever logged.
 */
function actionSetActive_(p) {
  requirePin_(p);
  var studentId = requireId_(p.student_id);
  if (p.active === undefined || p.active === null) fail_('missing active (true or false)');
  var active = truthy_(p.active);

  return withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var student = students[studentId];
    if (!student) fail_('no student with id ' + studentId);
    // Column 4 is `active` — see HEADERS[Students]; column order is the contract.
    sheet_(TAB_STUDENTS).getRange(student._row, 4).setValue(active);
    invalidateTable_(TAB_STUDENTS);      // an in-place write, so not via appendRows_

    // The whole record, not just the field that moved. The admin page patches
    // its local roster with this and never re-fetches, so anything it needs has
    // to come back here.
    student.active = active;
    return ok_({ student_id: studentId, name: student.name, active: active,
                 student: publicStudent_(student) });
  });
}

/**
 * Correct a student's name. Like `active`, `name` is roster data, not
 * attendance data — a misspelling at enrollment, a legal name change or a
 * student who goes by something else is a fact about the person, not about a
 * night in the lab. Nothing in Events stores a name (every row keys off
 * student_id, and names are joined in on read), so a rename is invisible to
 * every hour, session and statistic: the log is untouched and the totals come
 * out identical.
 *
 * There is no history of the old name. If a coach needs one, the fix is a
 * `note` on the Config tab, not a mutable column here.
 */
function actionSetName_(p) {
  requirePin_(p);
  var studentId = requireId_(p.student_id);
  var name = requireStr_(p, 'name', 80);

  return withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var student = students[studentId];
    if (!student) fail_('no student with id ' + studentId);

    var previous = student.name;
    if (name !== previous) {
      // Column 2 is `name` — see HEADERS[Students]; column order is the contract.
      sheet_(TAB_STUDENTS).getRange(student._row, 2).setValue(name);
      invalidateTable_(TAB_STUDENTS);    // an in-place write, so not via appendRows_
    }
    student.name = name;
    return ok_({ student_id: studentId, name: name, previous_name: previous,
                 changed: name !== previous, student: publicStudent_(student) });
  });
}

/**
 * Write a whole session by hand: a student, a date, a start and an end.
 *
 * This is for the evening the tablet was unplugged, or the student who left
 * their card at home — cases where there is no event to correct because there
 * was never a scan at all, so editEvent has nothing to supersede.
 *
 * It appends a matched IN/OUT pair with source "manual". Both rows are flagged:
 * the times came from a human's memory, and the admin UI should say so.
 *
 * Three checks, in the order a coach hits them:
 *   - end after start, so nothing can produce a negative duration
 *   - no overlap with a session that student already has, so a hand-entered
 *     evening cannot be double-counted on top of the scans that recorded it
 *   - under max_session_minutes from Config, the same ceiling the nightly
 *     auto-close applies, so the manual path is not a way around it
 *
 * Manual sessions are exempt from summary rejection — see
 * rejectUnloggedSessions().
 */
function actionAddManualSession_(p) {
  requirePin_(p);
  var studentId = requireId_(p.student_id);
  var date = String(p.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_('date must be YYYY-MM-DD');
  var startHm = String(p.start || p.start_time || '').trim();
  var endHm   = String(p.end || p.end_time || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(startHm)) fail_('start must look like "16:30"');
  if (!/^\d{1,2}:\d{2}$/.test(endHm)) fail_('end must look like "19:00"');
  var reason = String(p.reason || p.note || '').trim();

  // Same convention as localTimeOn_ elsewhere in this file: build the instant
  // from the calendar day plus a wall-clock time, so "16:30 on the 4th" means
  // what a coach means by it.
  var ref = new Date(date.replace(/-/g, '/') + ' 12:00:00');
  if (isNaN(ref.getTime())) fail_('could not read the date "' + date + '"');
  var startAt = localTimeOn_(ref, startHm);
  var endAt   = localTimeOn_(ref, endHm);
  if (!startAt || !endAt) fail_('could not read those times');
  if (endAt.getTime() <= startAt.getTime()) fail_('the end time must be after the start time');

  var minutes = minutesBetween_(startAt, endAt);
  var maxMinutes = cfgNum_('max_session_minutes', 360);
  if (minutes > maxMinutes) {
    fail_('that is ' + minutes + ' minutes; the maximum session is ' + maxMinutes +
          ' (change max_session_minutes in the Config tab to allow longer)');
  }

  return withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var student = students[studentId];
    if (!student) fail_('no student with id ' + studentId);

    var raw = readTable_(TAB_EVENTS);
    // Overlap is checked against rejected sessions too. A rejected session is
    // still a record of the student being in the lab; letting a coach type a
    // duplicate over one would double-count it the moment a late summary
    // recovered the original.
    var mine = groupByStudent_(resolveEvents_(raw, true))[studentId] || [];
    var existing = buildSessions_(mine);
    var now = new Date();
    for (var i = 0; i < existing.length; i++) {
      var e = existing[i];
      if (!e.in_time) continue;                       // an orphan OUT spans nothing
      var a = new Date(e.in_time).getTime();
      var b = e.out_time ? new Date(e.out_time).getTime() : now.getTime();
      if (startAt.getTime() < b && endAt.getTime() > a) {
        fail_(student.name + ' already has a session on ' + e.date + ' from ' +
              e.in_clock + ' to ' + (e.out_clock || 'now') + ' that overlaps this one');
      }
    }

    var note = 'manual entry by a coach' + (reason ? ' — ' + reason : '');
    var inEv = {
      event_id: newId_('evt'), student_id: studentId, timestamp: toIso_(startAt),
      direction: DIR_IN, source: SOURCE_MANUAL, flagged: true, note: note,
      status: STATUS_ACTIVE
    };
    var outEv = {
      event_id: newId_('evt'), student_id: studentId, timestamp: toIso_(endAt),
      direction: DIR_OUT, source: SOURCE_MANUAL, flagged: true, note: note,
      status: STATUS_ACTIVE
    };
    appendRows_(TAB_EVENTS, [eventRow_(inEv), eventRow_(outEv)]);

    return ok_({
      student_id: studentId, name: student.name, date: date,
      in_event_id: inEv.event_id, out_event_id: outEv.event_id,
      in_time: inEv.timestamp, out_time: outEv.timestamp, minutes: minutes,
      sessions: studentSessionsAfter_(raw, [inEv, outEv], studentId)
    });
  });
}

/**
 * Add or correct a student's email.
 *
 * Like `name` and `active`, this is roster data: the event log stores only
 * student_id, so changing an address moves no hour and no session. It exists
 * because collection is optional at the tablet — a student who skipped the
 * field, or typed it wrong with a queue behind them, has to be fixable later
 * without re-enrolling them.
 *
 * Passing an empty string clears the address, which stops the scan-out emails.
 * A student with no token gets one here, so an address added to a row that
 * predates tokens is immediately usable.
 */
function actionSetEmail_(p) {
  requirePin_(p);
  var studentId = requireId_(p.student_id);
  var email = normEmail_(p.email);

  return withLock_(function () {
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var student = students[studentId];
    if (!student) fail_('no student with id ' + studentId);

    var previous = student.email;
    var sh = sheet_(TAB_STUDENTS);
    var touched = false;
    if (email !== previous) {
      sh.getRange(student._row, COL_STUDENT_EMAIL).setValue(email);
      student.email = email;
      touched = true;
    }
    if (email && !student.summary_token) {
      student.summary_token = newToken_();
      sh.getRange(student._row, COL_STUDENT_TOKEN).setValue(student.summary_token);
      touched = true;
    }
    if (touched) invalidateTable_(TAB_STUDENTS);   // in place, so not via appendRows_

    return ok_({ student_id: studentId, name: student.name, email: email,
                 previous_email: previous, changed: email !== previous,
                 student: publicStudent_(student) });
  });
}

/**
 * Put rejected sessions back into the count, on a coach's say-so.
 *
 * Takes the event ids of the sessions to restore — both ends of each — so the
 * "Recover selected" button is one request no matter how many rows are ticked.
 * Recovery is idempotent: an id that is already active or recovered is counted
 * as a no-op rather than an error, because a double-click on a bulk action
 * should not produce a failure a coach has to interpret.
 */
function actionRecoverEvents_(p) {
  requirePin_(p);
  var ids = p.event_ids || p.eventIds;
  if (!(ids instanceof Array) || !ids.length) fail_('recoverEvents needs a non-empty event_ids array');
  if (ids.length > 1000) fail_('too many events in one request (max 1000)');

  return withLock_(function () {
    var raw = readTable_(TAB_EVENTS);
    var rowOf = rawRowIndex_(raw);
    var statusOf = {};
    var ownerOf = {};
    for (var r = 0; r < raw.length; r++) {
      var rid = String(raw[r].event_id || '').trim();
      if (!rid) continue;
      statusOf[rid] = normStatus_(raw[r].status);
      ownerOf[rid] = normId_(raw[r].student_id);
    }

    var updates = [];
    var recovered = [];
    var skipped = [];
    var seen = {};
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] || '').trim();
      if (!id || seen[id]) continue;
      seen[id] = true;
      if (!rowOf[id]) { skipped.push({ event_id: id, reason: 'no such event' }); continue; }
      if (statusOf[id] !== STATUS_REJECTED) {
        skipped.push({ event_id: id, reason: 'not rejected' });
        continue;
      }
      updates.push({ _row: rowOf[id], status: STATUS_RECOVERED });
      recovered.push(id);
    }
    setEventStatuses_(updates);

    // The caller's whole point is that these hours count again, and only the
    // server knows how the restored events re-pair. Hand back every affected
    // student's rebuilt timeline rather than making the page re-fetch.
    var byStudent = {};
    for (var u = 0; u < recovered.length; u++) {
      if (ownerOf[recovered[u]]) byStudent[ownerOf[recovered[u]]] = true;
    }
    var fresh = readTable_(TAB_EVENTS);
    var sessionsByStudent = {};
    for (var sid in byStudent) {
      if (!byStudent.hasOwnProperty(sid)) continue;
      sessionsByStudent[sid] = studentSessionsAfter_(fresh, [], sid);
    }

    return ok_({ recovered: recovered, skipped: skipped,
                 sessions_by_student: sessionsByStudent });
  });
}

/**
 * Sign off flagged sessions: a coach has checked the times, so they leave the
 * Needs review queue. Their hours already counted; this changes what the page
 * asks a human to look at, not any total.
 *
 * Takes event ids like recoverEvents, and verifies every session that one of
 * them belongs to — both ends, so a pair never ends up half verified. Only a
 * clean, completed session can be verified, and only once it is written up:
 * a summary on file for that day, a coach-entered session, or one a coach
 * already recovered. Verifying anything earlier would exempt it from the
 * nightly rejection (which only judges active sessions) and so let unlogged
 * time become official. Those come back in `skipped` with a reason, not as an
 * error, so a bulk "Verify all" still verifies everything it can.
 *
 * A later correction appends a fresh, unverified event, so an edited session
 * drops back into the queue on its own.
 */
function actionVerifySessions_(p) {
  requirePin_(p);
  var ids = p.event_ids || p.eventIds;
  if (!(ids instanceof Array) || !ids.length) fail_('verifySessions needs a non-empty event_ids array');
  if (ids.length > 1000) fail_('too many events in one request (max 1000)');

  return withLock_(function () {
    var raw = readTable_(TAB_EVENTS);
    var rowOf = rawRowIndex_(raw);
    var wanted = {};
    var ownerOf = {};
    for (var r = 0; r < raw.length; r++) {
      var rid = String(raw[r].event_id || '').trim();
      if (rid) ownerOf[rid] = normId_(raw[r].student_id);
    }
    var byStudent = {};
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] || '').trim();
      if (!id) continue;
      wanted[id] = true;
      if (ownerOf[id]) byStudent[ownerOf[id]] = true;
    }

    var logged = {};
    var summaryRows = resolveSummaries_(readTable_(TAB_SUMMARIES));
    for (var k = 0; k < summaryRows.length; k++) {
      var sidS = normId_(summaryRows[k].student_id);
      if (sidS && byStudent[sidS]) logged[sidS + '|' + summaryDate_(summaryRows[k])] = true;
    }

    var live = groupByStudent_(resolveEvents_(raw));
    var updates = [];
    var verified = 0;
    var skipped = [];
    for (var sid in byStudent) {
      if (!byStudent.hasOwnProperty(sid)) continue;
      var sessions = buildSessions_(live[sid] || []);
      for (var j = 0; j < sessions.length; j++) {
        var sess = sessions[j];
        if (!wanted[sess.in_event_id] && !wanted[sess.out_event_id]) continue;
        var reason = null;
        if (sess.status === 'open') reason = 'still checked in';
        else if (sess.status !== 'closed') reason = 'broken session: fix the times first';
        else if (sess.event_status !== STATUS_VERIFIED &&
                 sess.event_status !== STATUS_RECOVERED &&
                 (sess.sources || []).indexOf(SOURCE_MANUAL) < 0 &&
                 !logged[sid + '|' + sess.date]) reason = 'no summary yet';
        if (reason) {
          skipped.push({ student_id: sid, date: sess.date, in_event_id: sess.in_event_id,
                         out_event_id: sess.out_event_id, reason: reason });
          continue;
        }
        updates.push({ _row: rowOf[sess.in_event_id],  status: STATUS_VERIFIED });
        updates.push({ _row: rowOf[sess.out_event_id], status: STATUS_VERIFIED });
        verified++;
      }
    }
    setEventStatuses_(updates);

    var fresh = readTable_(TAB_EVENTS);
    var sessionsByStudent = {};
    for (var s2 in byStudent) {
      if (byStudent.hasOwnProperty(s2)) sessionsByStudent[s2] = studentSessionsAfter_(fresh, [], s2);
    }
    return ok_({ verified: verified, skipped: skipped, sessions_by_student: sessionsByStudent });
  });
}

// ---------------------------------------------------------------------------
// Setup — run these by hand from the Apps Script editor
// ---------------------------------------------------------------------------

/**
 * One-time setup. Safe to run again at any point: it only ever creates what is
 * missing. It never clears a tab, never rewrites a Config value that is already
 * set, and never touches existing data rows.
 */
function initializeSheets() {
  return withLock_(function () {
    CONFIG_CACHE = null;
    var ss = ss_();
    var report = { created_tabs: [], repaired_headers: [], columns_added: [],
                   config_added: [], tokens_backfilled: 0, notes: [] };

    var tabs = [TAB_STUDENTS, TAB_EVENTS, TAB_SUMMARIES, TAB_CONFIG, TAB_TEAMS];
    for (var i = 0; i < tabs.length; i++) {
      var name = tabs[i];
      var header = HEADERS[name];
      var sh = ss.getSheetByName(name);
      var isNew = false;
      if (!sh) {
        sh = ss.insertSheet(name);
        report.created_tabs.push(name);
        isNew = true;
      }
      // Write headers only if row 1 is blank or does not match. Never touch row 2+.
      var current = sh.getLastColumn()
        ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), header.length)).getValues()[0]
        : [];

      // Two very different situations, and they must not be reported the same
      // way. A tab whose existing columns match the start of the contract and
      // is simply MISSING the ones added later is a routine migration: writing
      // the header row adds the new names and leaves every data row alone, with
      // the new cells blank, which is exactly what the readers expect. A tab
      // whose columns disagree somewhere in the MIDDLE means somebody reordered
      // them, and rewriting row 1 there relabels real data — so that one gets
      // shouted about.
      var appendedOnly = true;
      var needsHeader = false;
      var added = [];
      for (var c = 0; c < header.length; c++) {
        var cell = String(current[c] === undefined || current[c] === null ? '' : current[c]).trim().toLowerCase();
        if (cell === header[c]) continue;
        needsHeader = true;
        if (cell === '') added.push(header[c]);
        else appendedOnly = false;
      }
      if (needsHeader) {
        if (sh.getLastRow() > 1 && !appendedOnly) {
          report.notes.push('tab "' + name + '" has data but wrong headers — headers rewritten, ' +
                            'CHECK that the existing columns line up with ' + header.join(', '));
        }
        sh.getRange(1, 1, 1, header.length).setValues([header]);
        report.repaired_headers.push(name);
        // Only on a tab that already existed. On a tab we just created, every
        // column is "added", which drowns the three that actually matter.
        if (!isNew) {
          for (var a = 0; a < added.length; a++) report.columns_added.push(name + '.' + added[a]);
        }
      }
      sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    // Everything below reads these tabs back through readTable_, which checks
    // the header row it just wrote. Push the writes out first so the migration
    // cannot read its own stale "column F is empty".
    SpreadsheetApp.flush();

    // Text formatting where Sheets would otherwise "helpfully" coerce values:
    // 7-digit IDs must not become numbers (leading zeros) and ISO timestamps
    // must not become spreadsheet dates.
    sheet_(TAB_STUDENTS).getRange('A:A').setNumberFormat('@');
    sheet_(TAB_STUDENTS).getRange('E:H').setNumberFormat('@');   // created_at, email, summary_token, team_id
    sheet_(TAB_TEAMS).getRange('A:C').setNumberFormat('@');      // team_id, name, created_at
    sheet_(TAB_EVENTS).getRange('B:C').setNumberFormat('@');
    sheet_(TAB_EVENTS).getRange('H:H').setNumberFormat('@');     // status
    sheet_(TAB_SUMMARIES).getRange('B:C').setNumberFormat('@');
    sheet_(TAB_SUMMARIES).getRange('F:F').setNumberFormat('@');
    sheet_(TAB_CONFIG).getRange('B:B').setNumberFormat('@');
    sheet_(TAB_EVENTS).setColumnWidth(3, 200);
    sheet_(TAB_SUMMARIES).setColumnWidth(4, 400);

    // Drop the default empty "Sheet1" once the real tabs exist.
    var leftover = ss.getSheetByName('Sheet1');
    if (leftover && leftover.getLastRow() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(leftover);
      report.notes.push('removed the empty default Sheet1');
    }

    // --- Drive folder ---
    var existingCfg = {};
    var cfgRows = readTable_(TAB_CONFIG);
    for (var r = 0; r < cfgRows.length; r++) {
      var key = String(cfgRows[r].key || '').trim();
      if (key) existingCfg[key] = String(cfgRows[r].value === null ? '' : cfgRows[r].value).trim();
    }

    var folder = null;
    if (existingCfg.drive_folder_id) {
      try { folder = DriveApp.getFolderById(existingCfg.drive_folder_id); }
      catch (e) { report.notes.push('configured drive_folder_id was unreachable, finding another'); }
    }
    if (!folder) {
      var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
      folder = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
    }

    // --- Config defaults: only fill in keys that are missing ---
    var defaults = {
      admin_pin: String(Math.floor(100000 + Math.random() * 900000)),
      lab_open: '15:00',
      lab_close: '21:00',
      max_session_minutes: '360',
      scan_debounce_seconds: '15',
      timezone: Session.getScriptTimeZone(),
      drive_folder_id: folder.getId(),
      // How long after scanning out a student has to submit a summary before
      // that session stops counting. Read by rejectUnloggedSessions() and
      // quoted in the scan-out email, so both always agree.
      grace_period_hours: '24',
      // "false" turns off the one-shot trigger that sends scan-out mail within
      // about 30 seconds, leaving delivery to the recurring flusher alone.
      summary_email_immediate: 'true',
      // The public URL of summary.html. Left empty on purpose: only you know
      // where this repo is published, and a wrong link in a student's inbox is
      // worse than no email. Until it is set, scan-out emails are not sent and
      // flushSummaryEmails says so in the log.
      summary_base_url: ''
    };
    var newRows = [];
    for (var k in defaults) {
      if (!defaults.hasOwnProperty(k)) continue;
      // hasOwnProperty, not truthiness: summary_base_url ships empty, and a
      // falsiness check would append a duplicate row on every run.
      if (existingCfg.hasOwnProperty(k)) continue;
      newRows.push([k, defaults[k]]);
      report.config_added.push(k);
    }
    // drive_folder_id may exist but point somewhere stale; repair it in place.
    if (existingCfg.drive_folder_id && existingCfg.drive_folder_id !== folder.getId()) {
      for (var cr = 0; cr < cfgRows.length; cr++) {
        if (String(cfgRows[cr].key).trim() === 'drive_folder_id') {
          sheet_(TAB_CONFIG).getRange(cfgRows[cr]._row, 2).setValue(folder.getId());
          report.notes.push('repaired drive_folder_id');
        }
      }
    }
    appendRows_(TAB_CONFIG, newRows);
    CONFIG_CACHE = null;

    // --- Backfill summary tokens for students enrolled before tokens existed.
    // One read and one write of column G, never touching any other cell. A row
    // that already has a token keeps it: the link may already be in an inbox.
    var studentRows = readTable_(TAB_STUDENTS);
    if (studentRows.length) {
      var lastStudentRow = 0;
      for (var sr = 0; sr < studentRows.length; sr++) {
        if (studentRows[sr]._row > lastStudentRow) lastStudentRow = studentRows[sr]._row;
      }
      var tokenRange = sheet_(TAB_STUDENTS).getRange(2, COL_STUDENT_TOKEN, lastStudentRow - 1, 1);
      var tokens = tokenRange.getValues();
      var minted = 0;
      for (var t = 0; t < tokens.length; t++) {
        if (String(tokens[t][0] || '').trim()) continue;
        tokens[t][0] = newToken_();
        minted++;
      }
      if (minted) {
        tokenRange.setValues(tokens);
        invalidateTable_(TAB_STUDENTS);
        report.tokens_backfilled = minted;
      }
    }

    report.drive_folder = { name: folder.getName(), id: folder.getId(), url: folder.getUrl() };
    report.admin_pin = existingCfg.admin_pin || defaults.admin_pin;
    report.spreadsheet_url = ss.getUrl();

    Logger.log('--- Robotics Lab Attendance: initializeSheets ---');
    Logger.log('Tabs created:      ' + (report.created_tabs.join(', ') || 'none (already existed)'));
    Logger.log('Headers written:   ' + (report.repaired_headers.join(', ') || 'none'));
    Logger.log('Columns added:     ' + (report.columns_added.join(', ') || 'none'));
    Logger.log('Config keys added: ' + (report.config_added.join(', ') || 'none'));
    Logger.log('Tokens backfilled: ' + report.tokens_backfilled);
    Logger.log('Drive folder:      ' + folder.getName() + '  ' + folder.getUrl());
    Logger.log('ADMIN PIN:         ' + report.admin_pin + '   (Config tab, key admin_pin — change it there)');
    for (var n = 0; n < report.notes.length; n++) Logger.log('Note: ' + report.notes[n]);
    if (!cfgStr_('summary_base_url', '')) {
      Logger.log('ACTION NEEDED:     Config summary_base_url is empty. Set it to the public URL of ' +
                 'summary.html (e.g. https://<user>.github.io/<repo>/summary.html) or no scan-out ' +
                 'emails will be sent.');
    }
    Logger.log('Next: run installNightlyTrigger() and installSummaryEmailTrigger(), ' +
               'then Deploy > New deployment > Web app.');

    return report;
  });
}

/**
 * Install the nightly trigger, on nightlyMaintenance().
 *
 * It removes any trigger on the OLD handler, autoCloseOpenSessions, as well as
 * its own. An installation that predates the rejection feature has a trigger
 * pointing straight at autoCloseOpenSessions; leaving it in place would run the
 * closer twice a night, once outside the chain that guarantees rejection runs
 * after it. Run this once after pasting in this version.
 *
 * Idempotent — safe to run again after changing lab_close in Config.
 */
function installNightlyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    var fn = existing[i].getHandlerFunction();
    if (fn === 'nightlyMaintenance' || fn === 'autoCloseOpenSessions' ||
        fn === 'rejectUnloggedSessions') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  // Apps Script time triggers fire within an hour of the requested time, so aim
  // for the hour after lab close. autoCloseOpenSessions backdates the OUT to
  // lab close itself, so the imprecision never lands in a student's hours.
  var close = cfgStr_('lab_close', '21:00');
  var hour = (parseInt(close.split(':')[0], 10) + 1) % 24;
  ScriptApp.newTrigger('nightlyMaintenance').timeBased().atHour(hour).everyDays(1).create();
  Logger.log('Nightly trigger installed on nightlyMaintenance() for ~' + hour + ':00 ' + tz_() +
             ' (removed ' + removed + ' previous)');
  return { removed: removed, hour: hour, lab_close: close, handler: 'nightlyMaintenance' };
}

/**
 * Kept so an older bookmark or a half-finished setup still works. It installs
 * the same single nightly trigger as installNightlyTrigger() — never a bare
 * autoCloseOpenSessions trigger, which would run outside the ordering the
 * rejection job depends on.
 */
function installAutoCloseTrigger() {
  return installNightlyTrigger();
}

/**
 * Install the summary-email flusher. Every five minutes, which is how long a
 * student might wait for the link after scanning out.
 *
 * This is a SEPARATE trigger from the nightly one on purpose: the scan path
 * only queues, so nothing sends until this runs, and holding the mail until
 * midnight would email students about a deadline most of the way through their
 * grace period. Idempotent.
 */
function installSummaryEmailTrigger(everyMinutes) {
  // Apps Script only accepts these, and fires them on a best-effort schedule:
  // the interval is a floor, not a promise, and a run can slip well past it.
  var allowed = [1, 5, 10, 15, 30];
  var minutes = Number(everyMinutes) || 5;
  if (allowed.indexOf(minutes) < 0) {
    throw new Error('everyMinutes must be one of ' + allowed.join(', '));
  }
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'flushSummaryEmails') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger('flushSummaryEmails').timeBased().everyMinutes(minutes).create();
  Logger.log('Summary email trigger installed, every ' + minutes + ' minute(s) (removed ' +
             removed + ' previous)');
  return { removed: removed, every_minutes: minutes };
}

// ---------------------------------------------------------------------------
// Nightly maintenance
// ---------------------------------------------------------------------------

/**
 * Close out anyone who forgot to scan on the way out. Runs on a nightly trigger.
 *
 * The synthetic OUT is backdated to lab close (or to the in-time plus
 * max_session_minutes, whichever comes first) and written with flagged = true
 * and an explaining note, so nobody banks nine hours for walking out the door.
 * Stale INs left over from earlier days get capped the same way.
 */
function autoCloseOpenSessions() {
  return withLock_(function () {
    var maxMinutes = cfgNum_('max_session_minutes', 360);
    var closeToday = localTimeOn_(new Date(), cfgStr_('lab_close', '21:00'));
    if (!closeToday) fail_('Config lab_close must look like "21:00"');
    var now = new Date();

    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var byStudent = groupByStudent_(resolveEvents_(readTable_(TAB_EVENTS)));

    var rows = [];
    var closed = [];
    var newIds = [];
    for (var sid in byStudent) {
      if (!byStudent.hasOwnProperty(sid)) continue;
      var events = byStudent[sid];
      var last = events[events.length - 1];
      if (!last || last.direction !== DIR_IN) continue;      // not in the lab; nothing to do

      var inMs = last.ts.getTime();
      var capMs = inMs + maxMinutes * 60000;
      var outMs;
      var reason;
      if (closeToday.getTime() > inMs) {
        outMs = Math.min(closeToday.getTime(), capMs);
        reason = outMs === capMs ? 'capped at max_session_minutes' : 'lab close';
      } else {
        // Scanned in after lab close (or the clock rolled past midnight):
        // close at the moment this job runs, still capped.
        outMs = Math.min(now.getTime(), capMs);
        reason = 'auto-close run';
      }
      if (outMs <= inMs) outMs = inMs;                        // never negative

      var outTs = new Date(outMs);
      var ev = {
        event_id: newId_('evt'),
        student_id: sid,
        timestamp: toIso_(outTs),      // synthetic, hence flagged below
        direction: DIR_OUT,
        source: SOURCE_AUTOCLOSE,
        flagged: true,
        note: 'auto-closed at ' + reason + ' — student did not scan out; ' +
              'session shown as ' + Math.max(0, minutesBetween_(last.ts, outTs)) + ' min, verify before counting'
      };
      rows.push(eventRow_(ev));
      newIds.push(ev.event_id);
      closed.push({
        student_id: sid,
        event_id: ev.event_id,
        name: students[sid] ? students[sid].name : '(not on roster)',
        in_time: last.timestamp,
        out_time: ev.timestamp,
        minutes: Math.max(0, minutesBetween_(last.ts, outTs)),
        reason: reason
      });
    }

    appendRows_(TAB_EVENTS, rows);
    Logger.log('autoCloseOpenSessions: closed ' + closed.length + ' open session(s)');
    for (var i = 0; i < closed.length; i++) {
      Logger.log('  ' + closed[i].name + '  ' + closed[i].in_time + ' -> ' + closed[i].out_time +
                 '  (' + closed[i].minutes + ' min, ' + closed[i].reason + ')');
    }
    return { closed: closed.length, sessions: closed, event_ids: newIds, ran_at: nowIso_() };
  });
}



/**
 * The nightly job. ONE trigger runs this; it runs the two steps in order.
 *
 * Ordering is not cosmetic. rejectUnloggedSessions only looks at COMPLETED
 * sessions, so a student still checked in is invisible to it — if rejection ran
 * first, the session autoCloseOpenSessions is about to close would be skipped
 * tonight and only judged tomorrow. Chaining them here makes the order a
 * property of the code rather than of how two triggers happened to be
 * scheduled, which is why installNightlyTrigger() installs this and not the
 * two functions separately.
 *
 * The second half is also told which OUT events the first half just invented.
 * An auto-closed OUT is BACKDATED to lab close, so measuring the grace period
 * from its timestamp would start the clock before the row existed — with a
 * short grace_period_hours a student could be rejected in the same run that
 * closed them, for failing to write a summary about a session that was not
 * over yet. Those sessions sit out tonight and get judged on the next run,
 * which guarantees the full grace period no matter how it is configured.
 */
function nightlyMaintenance() {
  var closedResult = autoCloseOpenSessions();
  var rejectResult = rejectUnloggedSessions({ skipEventIds: closedResult.event_ids || [] });
  return { auto_close: closedResult, rejection: rejectResult, ran_at: nowIso_() };
}

/**
 * Reject completed sessions that nobody wrote up.
 *
 * A session is rejected when all of these hold:
 *   - it is a clean, closed IN/OUT pair (a broken session is a review problem,
 *     not a policy problem, and is already surfaced in Needs review)
 *   - its check-out is older than grace_period_hours
 *   - the student has no summary in the sheet for that session's local day
 *   - it was not typed in by a coach — source "manual" is exempt, because a
 *     coach entering a session by hand IS the verification a summary provides
 *
 * Rejection sets status = "rejected" on BOTH ends, together, so the pair still
 * resolves as a pair and resolveEvents_ can drop it whole. Nothing is deleted
 * and no timestamp changes: the rows stay in the sheet exactly as written, and
 * a late summary — or a coach with the Recover button — puts them straight back.
 *
 * Idempotent. A session already rejected or recovered is left alone, so
 * re-running this never re-rejects hours a coach deliberately restored.
 */
function rejectUnloggedSessions(opts) {
  opts = opts || {};
  var skip = {};
  var skipList = opts.skipEventIds || [];
  for (var q = 0; q < skipList.length; q++) skip[skipList[q]] = true;

  return withLock_(function () {
    var graceHours = cfgNum_('grace_period_hours', 24);
    var cutoff = Date.now() - graceHours * 3600000;

    var raw = readTable_(TAB_EVENTS);
    var rowOf = rawRowIndex_(raw);
    var students = studentIndex_(readTable_(TAB_STUDENTS));
    var byStudent = groupByStudent_(resolveEvents_(raw, true));

    // student|date of every summary on file, so the check below is a lookup.
    var logged = {};
    var summaryRows = resolveSummaries_(readTable_(TAB_SUMMARIES));
    for (var i = 0; i < summaryRows.length; i++) {
      var sid0 = normId_(summaryRows[i].student_id);
      if (sid0) logged[sid0 + '|' + summaryDate_(summaryRows[i])] = true;
    }

    var updates = [];
    var rejected = [];
    for (var sid in byStudent) {
      if (!byStudent.hasOwnProperty(sid)) continue;
      var sessions = buildSessions_(byStudent[sid]);
      for (var j = 0; j < sessions.length; j++) {
        var sess = sessions[j];
        if (sess.status !== 'closed') continue;
        // Recovered and verified sessions are already judged; verifySessions only
        // signs off a session that is written up, so neither needs checking again.
        if (sess.event_status !== STATUS_ACTIVE) continue;
        if ((sess.sources || []).indexOf(SOURCE_MANUAL) >= 0) continue;
        if (skip[sess.out_event_id] || skip[sess.in_event_id]) continue;
        if (new Date(sess.out_time).getTime() > cutoff) continue; // still in grace
        if (logged[sid + '|' + sess.date]) continue;              // written up

        if (rowOf[sess.in_event_id])  updates.push({ _row: rowOf[sess.in_event_id],  status: STATUS_REJECTED });
        if (rowOf[sess.out_event_id]) updates.push({ _row: rowOf[sess.out_event_id], status: STATUS_REJECTED });
        rejected.push({
          student_id: sid,
          name: students[sid] ? students[sid].name : '(not on roster)',
          date: sess.date,
          minutes: sess.minutes,
          in_time: sess.in_time,
          out_time: sess.out_time
        });
      }
    }

    var changed = setEventStatuses_(updates);
    Logger.log('rejectUnloggedSessions: rejected ' + rejected.length + ' session(s) past a ' +
               graceHours + 'h grace period (' + changed + ' event rows updated)');
    for (var k = 0; k < rejected.length; k++) {
      Logger.log('  ' + rejected[k].name + '  ' + rejected[k].date + '  ' + rejected[k].minutes + ' min');
    }
    return { rejected: rejected.length, sessions: rejected,
             grace_period_hours: graceHours, ran_at: nowIso_() };
  });
}

// ---------------------------------------------------------------------------
// Summary emails
//
// When a student scans out, they get their own summary link by email. Two
// things shape how this is built.
//
// 1. THE SCAN MUST NOT WAIT. A student is standing at a wall tablet with a
//    queue behind them. MailApp.sendEmail takes hundreds of milliseconds and
//    can fail outright, and Apps Script has no way to fire and forget inside a
//    request. So actionScan_ appends one entry to a queue in ScriptProperties
//    — a single fast write, after the lock is released — and returns. A
//    separate flushSummaryEmails trigger sends them a few minutes later.
//
// 2. THE QUOTA IS SMALL AND SHARED. MailApp allows 100 recipients a day on a
//    consumer Gmail account (1,500 on Workspace), counted across everything
//    the account sends. A team of 30 scanning out twice on a build weekend
//    will get close. The flusher checks the remaining quota before every send,
//    warns in the log as it runs low, and when it hits zero it stops and LEAVES
//    the rest queued for tomorrow rather than throwing them away. Nothing here
//    can break a scan, because nothing here runs during one.
// ---------------------------------------------------------------------------

/**
 * Append one pending email. Called after the scan's lock is released.
 *
 * Every failure path is swallowed: a scan that recorded a student's hours has
 * already succeeded, and losing the courtesy email is not a reason to tell
 * them their check-out failed.
 */
function queueSummaryEmail_(item) {
  try {
    var props = PropertiesService.getScriptProperties();
    var queue = readMailQueue_(props);
    item.queued_at = nowIso_();
    queue.push(item);
    if (queue.length > MAIL_QUEUE_MAX) queue = queue.slice(queue.length - MAIL_QUEUE_MAX);
    props.setProperty(MAIL_QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.warn('could not queue the summary email: ' + err);
    return;
  }
  kickSummaryFlush_();
}

/**
 * Ask for the queue to be flushed in about 30 seconds.
 *
 * The recurring trigger is a safety net, not a delivery mechanism. Apps Script
 * fires time triggers on a best-effort schedule, so "every 5 minutes" really
 * means "usually within 5, sometimes 30" — which is fine for a 24-hour deadline
 * and useless for anyone trying to confirm the feature works.
 *
 * A one-shot trigger created at queue time is the only way to get a bounded
 * delay out of Apps Script. Three things keep it from becoming a problem:
 *
 *   - Scans that land in the same 90 seconds share one trigger, so twenty
 *     students leaving together create one, not twenty.
 *   - flushSummaryEmails deletes the spent trigger when it runs, so they do not
 *     accumulate against the 20-per-user cap.
 *   - If the project is already crowded, or anything here fails at all, it
 *     gives up silently and the recurring flusher delivers as before. This is
 *     an optimisation, never a dependency.
 *
 * Costs the scan a trigger creation — a couple of hundred milliseconds, once
 * per 90 seconds across the whole team, and only on a scan-OUT by a student
 * with an email. Set Config summary_email_immediate to "false" to switch it off
 * and rely on the recurring trigger alone.
 */
function kickSummaryFlush_() {
  try {
    if (/^(false|no|0|off)$/i.test(cfgStr_('summary_email_immediate', 'true'))) return;

    var props = PropertiesService.getScriptProperties();
    var pending = props.getProperty(MAIL_KICK_KEY);
    if (pending) {
      var info = JSON.parse(pending);
      if (Date.now() - Number(info.at || 0) < MAIL_KICK_WINDOW_MS) return;   // one is already coming
    }

    if (ScriptApp.getProjectTriggers().length >= MAIL_KICK_TRIGGER_CAP) {
      console.warn('too many triggers to add a one-shot mail flush; the recurring one will send');
      return;
    }

    var trigger = ScriptApp.newTrigger('flushSummaryEmails')
                    .timeBased().after(MAIL_KICK_DELAY_MS).create();
    props.setProperty(MAIL_KICK_KEY, JSON.stringify({ id: trigger.getUniqueId(), at: Date.now() }));
  } catch (err) {
    // Never a reason to fail a scan, and never a reason to lose the mail: the
    // recurring trigger is still there.
    console.warn('could not schedule an immediate mail flush: ' + err);
  }
}

/** Delete the spent one-shot trigger. Called by the flusher it scheduled. */
function clearSummaryKick_(props) {
  try {
    var raw = props.getProperty(MAIL_KICK_KEY);
    if (!raw) return;
    var id = JSON.parse(raw).id;
    props.deleteProperty(MAIL_KICK_KEY);
    if (!id) return;
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getUniqueId() === id) ScriptApp.deleteTrigger(triggers[i]);
    }
  } catch (err) {
    console.warn('could not clear the spent one-shot mail trigger: ' + err);
  }
}

function readMailQueue_(props) {
  try {
    var raw = props.getProperty(MAIL_QUEUE_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return parsed instanceof Array ? parsed : [];
  } catch (err) {
    console.warn('summary mail queue was unreadable, discarding it: ' + err);
    return [];
  }
}

/**
 * Send everything queued. Runs on its own frequent trigger — see
 * installSummaryEmailTrigger().
 *
 * The queue is claimed under the script lock and emptied before the first send,
 * so a second flush that overlaps this one cannot send the same mail twice.
 * Anything that could not go out is written back at the end.
 */
function flushSummaryEmails() {
  var props = PropertiesService.getScriptProperties();
  // Whether or not there is mail, a one-shot trigger that has now fired is
  // spent and must not sit there counting against the 20-per-user cap.
  clearSummaryKick_(props);

  // Peek BEFORE touching the lock. This runs every few minutes forever and the
  // queue is empty almost every time, so taking a lock the scanner also wants
  // — and blocking on it for ten seconds if a student is mid-scan — is pure
  // contention for a run that has nothing to do. A stale read here is
  // harmless: the worst case is skipping a flush that the next run picks up,
  // and the authoritative read happens under the lock below.
  if (!readMailQueue_(props).length) return { sent: 0, skipped: 0, remaining: 0 };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('flushSummaryEmails: sheet is busy, leaving the queue for the next run');
    return { sent: 0, skipped: 0, remaining: null };
  }
  var batch;
  try {
    batch = readMailQueue_(props);
    props.deleteProperty(MAIL_QUEUE_KEY);
  } finally {
    lock.releaseLock();
  }
  if (!batch.length) return { sent: 0, skipped: 0, remaining: 0 };

  var base = cfgStr_('summary_base_url', '');
  if (!base) {
    // Hold, do not discard. This is a configuration gap, not a bad address:
    // the moment summary_base_url is filled in, the next run sends what is
    // waiting. The age check below still prunes anything that goes stale.
    putBackMailQueue_(props, batch);
    console.warn('flushSummaryEmails: Config summary_base_url is empty, so there is no link ' +
                 'to send. Holding ' + batch.length + ' queued email(s). Set it to the public ' +
                 'URL of summary.html, e.g. https://<user>.github.io/<repo>/summary.html');
    return { sent: 0, skipped: 0, remaining: batch.length, held_reason: 'summary_base_url is not set' };
  }

  var quota = mailQuota_();
  if (quota <= MAIL_QUOTA_WARN) {
    console.warn('MailApp daily quota is down to ' + quota + ' recipients');
  }

  var cutoff = Date.now() - MAIL_MAX_AGE_MS;
  var sent = 0, skipped = 0, worstWaitSec = 0;
  var leftover = [];

  for (var i = 0; i < batch.length; i++) {
    var item = batch[i] || {};
    var queuedMs = new Date(item.queued_at || 0).getTime();
    if (!item.to || !item.token) { skipped++; continue; }
    // A day-old reminder to log hours that were already rejected is noise.
    if (queuedMs && queuedMs < cutoff) { skipped++; continue; }

    if (quota <= 0) {
      // Out of quota: keep the rest for tomorrow rather than dropping them.
      leftover.push(item);
      continue;
    }
    try {
      MailApp.sendEmail(summaryEmail_(item, base));
      quota--;
      sent++;
      if (queuedMs) {
        var waitedSec = Math.round((Date.now() - queuedMs) / 1000);
        if (waitedSec > worstWaitSec) worstWaitSec = waitedSec;
        Logger.log('  sent to ' + item.to + ' — waited ' + waitedSec + 's since the scan-out');
      }
    } catch (err) {
      console.error('could not send the summary email to ' + item.to + ': ' + err);
      skipped++;
    }
  }

  if (leftover.length) {
    putBackMailQueue_(props, leftover);
    console.warn('MailApp daily quota is exhausted — ' + leftover.length +
                 ' summary email(s) held over until tomorrow');
  }

  Logger.log('flushSummaryEmails: sent ' + sent + ', skipped ' + skipped +
             ', held ' + leftover.length + ', quota left ' + Math.max(0, quota) +
             (worstWaitSec ? ', longest wait ' + worstWaitSec + 's' : ''));
  if (worstWaitSec > 15 * 60) {
    console.warn('A summary email waited ' + Math.round(worstWaitSec / 60) + ' minutes to go out. ' +
                 'Apps Script fires time triggers on a best-effort schedule, so the interval is a ' +
                 'floor, not a promise. Check Executions for gaps or failures in flushSummaryEmails.');
  }
  return { sent: sent, skipped: skipped, remaining: leftover.length,
           quota_left: Math.max(0, quota), longest_wait_seconds: worstWaitSec };
}

/** Return claimed items to the queue, merged with anything queued meanwhile. */
function putBackMailQueue_(props, items) {
  if (!items.length) return;
  var lock = LockService.getScriptLock();
  var locked = lock.tryLock(10000);
  try {
    props.setProperty(MAIL_QUEUE_KEY, JSON.stringify(readMailQueue_(props).concat(items)));
  } catch (err) {
    console.error('could not put ' + items.length + ' summary email(s) back on the queue: ' + err);
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Remaining recipients today, or a pessimistic 0 if the check itself fails. */
function mailQuota_() {
  try {
    return MailApp.getRemainingDailyQuota();
  } catch (err) {
    console.error('could not read the MailApp quota: ' + err);
    return 0;
  }
}

/** The message. Plain text: it is read on a phone, on the way out the door. */
function summaryEmail_(item, base) {
  var link = base + (base.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(item.token);
  var first = String(item.name || '').split(' ')[0] || 'there';
  var grace = cfgNum_('grace_period_hours', 24);
  var out = parseTs_(item.out_time) || new Date();
  var deadline = new Date(out.getTime() + grace * 3600000);
  var dur = item.minutes == null ? null : fmtMinutes_(item.minutes);
  var day = Utilities.formatDate(out, tz_(), 'EEEE, MMMM d');
  var by = Utilities.formatDate(deadline, tz_(), 'EEEE, MMMM d') + ' at ' +
           Utilities.formatDate(deadline, tz_(), 'h:mm a');

  var at = Utilities.formatDate(out, tz_(), 'h:mm a');

  // Gmail collapses the part of a message that repeats what an earlier message
  // in the same thread already said, behind a "..." nobody expands. Every one
  // of these mails ended the same way, so from the second one on a student saw
  // the text stop mid-sentence at "Lab time without a". Two things keep that
  // from happening: the subject carries the scan-out time, so consecutive mails
  // are not one thread at all, and the last lines of the body -- the deadline
  // and the session stamp -- differ every time, so there is no identical tail
  // left to collapse. Keep something session-specific last if this is reworded.
  var body =
    'Hi ' + first + ',\n\n' +
    'You logged ' + (dur ? dur : 'a session') + ' in the lab on ' + day + '.\n\n' +
    'Write up what you worked on here:\n' + link + '\n\n' +
    'The link is yours — it already knows who you are, so there is nothing to type in. ' +
    'Lab time without a summary does not count toward your hours, and a late summary ' +
    'brings them back automatically as soon as it lands.\n\n' +
    'Please submit it by ' + by + '.\n\n' +
    '— Robotics lab hours (scanned out ' + day + ' at ' + at + ')';

  return {
    to: item.to,
    subject: 'Log your lab hours — ' + day + ' at ' + at,
    body: body,
    name: 'Robotics Lab Hours'
  };
}

function fmtMinutes_(m) {
  if (m == null) return '';
  if (m < 60) return m + ' minutes';
  var h = Math.floor(m / 60), rest = m % 60;
  return rest ? h + 'h ' + rest + 'm' : h + (h === 1 ? ' hour' : ' hours');
}

// ---------------------------------------------------------------------------
// Diagnostics — run from the editor when something did not happen
// ---------------------------------------------------------------------------

/**
 * "I scanned out and no email arrived." Run this from the editor and read the
 * log top to bottom; it walks the whole chain in the order it can break and
 * says which link is the broken one.
 *
 * Pass a student id to check one student specifically, or nothing to check the
 * roster as a whole.
 *
 * It reads Students straight off the sheet, NOT through readTable_. The table
 * cache is invalidated by every write that goes through this file, but nothing
 * can invalidate it when a value is typed into the Sheet by hand — so an email
 * added directly in the tab is invisible to a scan for up to six hours, and
 * comparing the two reads is the only way to see that from here.
 */
function diagnoseSummaryEmail(studentId) {
  var problems = [];
  var notes = [];

  Logger.log('=== Summary email diagnosis ===');

  // 1. Is the schema even migrated?
  var headerRow = sheet_(TAB_STUDENTS).getRange(1, 1, 1, HEADERS[TAB_STUDENTS].length).getValues()[0];
  var headerOk = String(headerRow[COL_STUDENT_EMAIL - 1]).trim().toLowerCase() === 'email' &&
                 String(headerRow[COL_STUDENT_TOKEN - 1]).trim().toLowerCase() === 'summary_token';
  Logger.log('1. Students has email/summary_token columns: ' + (headerOk ? 'yes' : 'NO'));
  if (!headerOk) problems.push('Students is missing the email/summary_token columns — run initializeSheets()');

  // 2. The link to send.
  var base = cfgStr_('summary_base_url', '');
  Logger.log('2. Config summary_base_url: ' + (base || '(EMPTY)'));
  if (!base) problems.push('Config summary_base_url is empty — no email can be sent until it holds the public URL of summary.html');

  // 3. The trigger that actually sends.
  var triggers = ScriptApp.getProjectTriggers();
  var handlers = [];
  for (var t = 0; t < triggers.length; t++) handlers.push(triggers[t].getHandlerFunction());
  Logger.log('3. Installed triggers: ' + (handlers.join(', ') || '(none)'));
  if (handlers.indexOf('flushSummaryEmails') < 0) {
    problems.push('No flushSummaryEmails trigger — nothing sends the queued mail. Run installSummaryEmailTrigger()');
  }
  if (handlers.indexOf('nightlyMaintenance') < 0) {
    notes.push('No nightlyMaintenance trigger either — run installNightlyTrigger()');
  }
  if (handlers.indexOf('autoCloseOpenSessions') >= 0) {
    problems.push('A bare autoCloseOpenSessions trigger is still installed — run installNightlyTrigger() to replace it');
  }

  // 4. Can this account send at all?
  var quota = mailQuota_();
  Logger.log('4. MailApp recipients left today: ' + quota);
  if (quota <= 0) problems.push('MailApp daily quota is exhausted — queued mail is held until tomorrow');

  // 4b. How mail actually gets out.
  var immediate = !/^(false|no|0|off)$/i.test(cfgStr_('summary_email_immediate', 'true'));
  Logger.log('4b. Immediate one-shot flush on scan-out: ' + (immediate ? 'on (~30s)' : 'OFF'));
  if (!immediate) {
    notes.push('summary_email_immediate is off, so mail waits for the recurring trigger, ' +
               'which Apps Script fires on a best-effort schedule');
  }

  // 5. What is waiting to go out.
  var queue = readMailQueue_(PropertiesService.getScriptProperties());
  Logger.log('5. Emails waiting in the queue: ' + queue.length);
  for (var q = 0; q < queue.length; q++) {
    Logger.log('     ' + queue[q].to + '  queued ' + queue[q].queued_at + '  (' + queue[q].minutes + ' min)');
  }

  // 6. The roster, read past the cache.
  var fresh = loadTable_(TAB_STUDENTS);
  var cached = studentIndex_(readTable_(TAB_STUDENTS));
  var withEmail = 0, withToken = 0, stale = [];
  for (var i = 0; i < fresh.length; i++) {
    var sid = normId_(fresh[i].student_id);
    if (!sid) continue;
    if (studentId && sid !== normId_(studentId)) continue;
    var email = String(fresh[i].email || '').trim();
    var token = String(fresh[i].summary_token || '').trim();
    if (email) withEmail++;
    if (token) withToken++;
    var seenByScan = cached[sid] ? cached[sid].email : '';
    if (email !== seenByScan) stale.push(sid + ' (' + String(fresh[i].name || '') + ')');
    if (studentId) {
      Logger.log('6. ' + fresh[i].name + ' [' + sid + ']');
      Logger.log('     email on the sheet:  ' + (email || '(none)'));
      Logger.log('     email a scan sees:   ' + (seenByScan || '(none)'));
      Logger.log('     summary_token:       ' + (token ? token.slice(0, 6) + '… (' + token.length + ' chars)' : '(NONE)'));
      if (!email) problems.push(fresh[i].name + ' has no email on the roster');
      if (!token) problems.push(fresh[i].name + ' has no summary_token — run initializeSheets() to backfill');
    }
  }
  if (!studentId) {
    Logger.log('6. Roster: ' + withEmail + ' student(s) with an email, ' + withToken + ' with a token');
    if (!withToken) problems.push('No student has a summary_token — run initializeSheets() to backfill');
  }

  // 7. The trap that has no other symptom.
  if (stale.length) {
    Logger.log('7. STALE CACHE for: ' + stale.join(', '));
    problems.push('An email was typed straight into the Sheet, and the cached roster a scan reads ' +
                  'still has the old value. Nothing invalidates the cache on a hand edit. Run ' +
                  'refreshCaches() now, or edit the address from the admin page instead, which ' +
                  'invalidates it for you.');
  } else {
    Logger.log('7. Cached roster agrees with the sheet: yes');
  }

  Logger.log('---');
  if (problems.length) {
    for (var p = 0; p < problems.length; p++) Logger.log('PROBLEM: ' + problems[p]);
  } else {
    Logger.log('Nothing obviously wrong. If mail is sitting in the queue, run flushSummaryEmails() ' +
               'to send it now and read what it reports.');
  }
  for (var n = 0; n < notes.length; n++) Logger.log('Note: ' + notes[n]);

  return { problems: problems, notes: notes, queued: queue.length, quota: quota,
           summary_base_url: base, triggers: handlers, stale_students: stale };
}

/**
 * Drop every cached tab, so the next read comes off the sheet.
 *
 * Every write that goes through this file invalidates for itself. This is for
 * the case nothing can catch: a value typed straight into the Sheet by hand,
 * which the cache has no way to notice and will keep serving for up to six
 * hours. Run it after editing a tab directly.
 */
function refreshCaches() {
  var tabs = [TAB_STUDENTS, TAB_EVENTS, TAB_SUMMARIES, TAB_CONFIG, TAB_TEAMS];
  for (var i = 0; i < tabs.length; i++) invalidateTable_(tabs[i]);
  CONFIG_CACHE = null;
  TABLE_MEMO_ = {};
  Logger.log('Cleared the cached copy of: ' + tabs.join(', '));
  return { cleared: tabs };
}

/**
 * Send the email a scan-out would have sent, without scanning. Use it to prove
 * the mail path works once diagnoseSummaryEmail() is clean.
 *
 * Two ways to call it, because the editor's Run button cannot pass an argument:
 *
 *   sendTestSummaryEmail()          — press Run. Sends to YOU, the account
 *                                     running the script, using the first
 *                                     student who has a token so the link in
 *                                     it is real and clickable.
 *   sendTestSummaryEmail('1234567') — sends to that student's own address,
 *                                     exactly as a real scan-out would.
 *
 * No-arg deliberately mails the operator rather than a student: pressing Run on
 * a function whose name starts with "send" must not put mail in a kid's inbox.
 */
function sendTestSummaryEmail(studentId) {
  var base = cfgStr_('summary_base_url', '');
  if (!base) {
    throw new Error('Config summary_base_url is empty — set it in the Config tab, ' +
                    'then run refreshCaches() so this reads the new value');
  }
  var students = studentIndex_(loadTable_(TAB_STUDENTS));
  var student = null;
  var recipient;

  if (studentId === undefined || studentId === null || String(studentId).trim() === '') {
    for (var sid in students) {
      if (!students.hasOwnProperty(sid)) continue;
      if (students[sid].summary_token) { student = students[sid]; break; }
    }
    if (!student) throw new Error('no student has a summary_token yet — run initializeSheets() to backfill');
    recipient = Session.getEffectiveUser().getEmail();
    if (!recipient) throw new Error('could not work out your own address — call this with a student id instead');
    Logger.log('No student id given (the Run button cannot pass one), so this is going to YOU at ' +
               recipient + ', using ' + student.name + "'s link.");
  } else {
    student = students[normId_(studentId)];
    if (!student) {
      throw new Error('no student with id "' + studentId + '" — pass a 7-digit id as a string, ' +
                      'e.g. sendTestSummaryEmail(\'1234567\'), or call it with no argument to ' +
                      'send to yourself');
    }
    if (!student.email) throw new Error(student.name + ' has no email on the roster');
    if (!student.summary_token) throw new Error(student.name + ' has no summary_token — run initializeSheets()');
    recipient = student.email;
  }

  var now = new Date();
  MailApp.sendEmail(summaryEmail_({
    to: recipient, name: student.name, token: student.summary_token,
    date: dateKey_(now), minutes: 60, in_time: toIso_(new Date(now.getTime() - 3600000)),
    out_time: toIso_(now)
  }, base));
  Logger.log('Sent a test summary email to ' + recipient);
  return { sent_to: recipient, student: student.name };
}

// ---------------------------------------------------------------------------
// Manual smoke test — run from the editor after setup.
// Uses the dummy ID 1234567. Never put a real student ID in this file.
// ---------------------------------------------------------------------------

function smokeTest() {
  var TEST_ID = '1234567';
  var pin = cfgStr_('admin_pin', '');
  var log = [];

  function step(label, payload) {
    var res = JSON.parse(doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
    log.push(label + ': ' + JSON.stringify(res));
    Logger.log(label + ' -> ' + JSON.stringify(res));
    return res;
  }

  Logger.log('health -> ' + doGet({}).getContent());

  var scan1 = step('scan (unknown or in)', { action: 'scan', student_id: TEST_ID });
  if (scan1.ok && scan1.data.status === 'unknown') {
    step('enroll', { action: 'enroll', student_id: TEST_ID, name: 'Test Student', grade: '11' });
    scan1 = step('scan again', { action: 'scan', student_id: TEST_ID });
  }
  step('scan immediately (expect debounced)', { action: 'scan', student_id: TEST_ID });
  step('roster', { action: 'getRoster', pin: pin });
  step('timesheet', { action: 'getTimesheet', pin: pin });
  step('student detail', { action: 'getStudent', pin: pin, student_id: TEST_ID });
  if (scan1.ok && scan1.data.event_id) {
    step('void that event', { action: 'deleteEvent', pin: pin, event_id: scan1.data.event_id,
                              reason: 'smoke test cleanup' });
  }
  step('bad pin (expect error)', { action: 'getRoster', pin: '000000' });
  step('bad id (expect error)', { action: 'scan', student_id: '12' });

  // --- the newer features ---------------------------------------------------
  step('set email', { action: 'setEmail', pin: pin, student_id: TEST_ID, email: 'test@example.com' });
  step('bad email (expect error)', { action: 'setEmail', pin: pin, student_id: TEST_ID, email: 'nope' });

  var token = '';
  var rows = readTable_(TAB_STUDENTS);
  for (var i = 0; i < rows.length; i++) {
    if (normId_(rows[i].student_id) === TEST_ID) token = String(rows[i].summary_token || '');
  }
  Logger.log('token for the test student: ' + (token ? 'present' : 'MISSING — run initializeSheets()'));
  if (token) step('lookup by token', { action: 'lookupToken', t: token, date: dateKey_(new Date()) });
  step('lookup by a bogus token', { action: 'lookupToken', t: 'not-a-real-token-0000000000' });

  step('manual session', { action: 'addManualSession', pin: pin, student_id: TEST_ID,
                           date: dateKey_(new Date(Date.now() - 7 * 86400000)),
                           start: '16:00', end: '18:00', reason: 'smoke test' });
  step('manual session, overlapping (expect error)', { action: 'addManualSession', pin: pin,
                           student_id: TEST_ID, date: dateKey_(new Date(Date.now() - 7 * 86400000)),
                           start: '17:00', end: '19:00' });
  step('manual session, backwards (expect error)', { action: 'addManualSession', pin: pin,
                           student_id: TEST_ID, date: dateKey_(new Date()), start: '19:00', end: '17:00' });

  step('timesheet including rejected', { action: 'getTimesheet', pin: pin, include_rejected: true });
  Logger.log('rejectUnloggedSessions -> ' + JSON.stringify(rejectUnloggedSessions()));
  Logger.log('MailApp quota left: ' + mailQuota_());

  return log;
}
