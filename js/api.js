/**
 * Shared API client for the Robotics Lab Attendance Tracker.
 *
 * This is the ONLY module in the project that calls fetch(). Pages import from
 * here; they never talk to the network themselves.
 *
 * ======================= READ THIS BEFORE EDITING =========================
 *
 * Every POST sends `Content-Type: text/plain` with a JSON string body, and the
 * Apps Script backend parses it with JSON.parse(e.postData.contents).
 *
 * That looks wrong and it is deliberate. text/plain is one of the three CORS
 * "simple request" content types, so the browser sends the POST WITHOUT a
 * preflight. Apps Script Web Apps cannot answer an OPTIONS preflight — there is
 * no doOptions() — so the instant a request stops being simple it fails before
 * the server ever sees it. Setting `application/json` "properly" breaks every
 * write in the app with an opaque CORS error.
 *
 * For the same reason: no custom request headers. No Authorization, no
 * X-Anything — those trigger a preflight too. The admin PIN travels in the JSON
 * body instead.
 * ==========================================================================
 */

const DEFAULT_TIMEOUT_MS = 15000;

/** Errors carry a `kind` so callers can tell "queue this" from "show this". */
export class ApiError extends Error {
  constructor(message, kind, cause) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;          // 'network' | 'busy' | 'server' | 'config'
    this.cause = cause;
  }
  /** True when the request never got a usable answer. */
  get isNetwork() {
    return this.kind === 'network';
  }
  /**
   * True when the SAME request is worth sending again later: no answer at all,
   * or the server said it was momentarily busy. A wrong URL or a rejected
   * payload is NOT retryable — retrying those forever is how a broken
   * deployment turns into a queue of scans that never sync.
   */
  get isRetryable() {
    return this.kind === 'network' || this.kind === 'busy';
  }
}

// --- config -----------------------------------------------------------------

let configPromise = null;

/**
 * config.js is gitignored, so a fresh clone will not have it. Import it lazily
 * and turn the resulting 404 into an instruction rather than a stack trace.
 */
async function apiUrl() {
  if (!configPromise) {
    configPromise = import('../config.js')
      .catch(() => {
        throw new ApiError(
          'config.js is missing — copy config.example.js to config.js and paste your Apps Script URL into it',
          'config'
        );
      })
      .then((mod) => {
        const url = String(mod.API_URL || '').trim();
        if (!url || url.includes('PASTE_DEPLOYMENT_ID_HERE')) {
          throw new ApiError('config.js has no API_URL yet — paste your deployed Apps Script /exec URL into it', 'config');
        }
        return url;
      });
    // Do not cache a rejection: let the next call try again.
    configPromise.catch(() => { configPromise = null; });
  }
  return configPromise;
}

// --- transport --------------------------------------------------------------

/**
 * POST one action and return its `data`, or throw an ApiError.
 * Every backend response is {ok:true,data:...} or {ok:false,error:"..."}.
 */
export async function request(action, payload = {}, options = {}) {
  const url = await apiUrl();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // Deliberate. See the CORS note at the top of this file.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action, ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    const message = controller.signal.aborted
      ? `the server did not answer within ${Math.round(timeoutMs / 1000)}s`
      : (navigator.onLine === false ? 'no internet connection' : 'could not reach the server');
    throw new ApiError(message, 'network', err);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 5xx and 429 are Google having a moment: retry those.
    // A 4xx means the URL or the deployment is wrong, and treating that as
    // retryable is actively harmful — the tablet would queue every scan behind
    // a cheerful "saved, will sync" that never syncs, and the loss would only
    // surface when a coach noticed a week missing from the timesheet.
    if (response.status >= 500 || response.status === 429) {
      throw new ApiError(`the server is having trouble (HTTP ${response.status})`, 'network');
    }
    throw new ApiError(
      response.status === 404
        ? 'the API URL is wrong or that deployment no longer exists (HTTP 404) — check config.js'
        : `the server rejected the request (HTTP ${response.status})`,
      response.status === 404 ? 'config' : 'server');
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Apps Script serves an HTML sign-in page when the deployment's access is
    // not set to "Anyone" — the most common misconfiguration by far.
    if (/<html/i.test(text)) {
      throw new ApiError(
        'the Web App returned a sign-in page — redeploy it with "Who has access: Anyone"',
        'server'
      );
    }
    throw new ApiError('the server sent a response that was not JSON', 'server');
  }

  if (!body || typeof body !== 'object') throw new ApiError('malformed response', 'server');
  // The backend marks lock contention retryable so a scan is queued, not lost.
  if (body.ok === false) {
    throw new ApiError(String(body.error || 'unknown server error'), body.retryable ? 'busy' : 'server');
  }
  return body.data;
}

// --- student / tablet actions ----------------------------------------------

/**
 * Record a scan. Resolves to one of:
 *   {status:'ok', name, direction:'in'|'out', duration_minutes, ...}
 *   {status:'unknown', student_id}    not on the roster — offer enrollment
 *   {status:'inactive', student_id, name}
 *   {status:'debounced', name, direction, seconds_ago}   nothing was written
 */
export function scan(studentId, options = {}) {
  return request('scan', { student_id: studentId, source: options.source || 'tablet' }, options);
}

/**
 * Add a student to the roster. `email` is optional in the real sense: the
 * tablet's enrollment sheet has a Skip button, and an empty string is a normal
 * answer the backend accepts without complaint.
 */
export function enroll(studentId, name, grade = '', email = '', options = {}) {
  return request('enroll', { student_id: studentId, name, grade, email }, options);
}

/**
 * Replay scans captured while offline. Each item is
 * {student_id, timestamp (ISO), direction?}. These are the only writes that
 * carry a client clock, and the server flags every one of them as unverified.
 */
export function syncQueue(scans, options = {}) {
  return request('syncQueue', { scans }, options);
}

/**
 * Confirm an ID and, given a date, describe that day's lab time.
 * Resolves to {found:false} for an unknown ID rather than throwing — the
 * summary page treats that as "check the number", not as an error.
 * Writes nothing; safe to call as the student types.
 */
export function lookupStudent(studentId, date = null, options = {}) {
  const payload = { student_id: studentId };
  if (date) payload.date = date;
  return request('lookupStudent', payload, options);
}

/**
 * Resolve a summary link token (?t=… in the emailed link) to the student who
 * owns it, and optionally that day's lab time.
 *
 * Resolves to {found:false} for a token that means nothing, rather than
 * throwing — an expired bookmark should send the student back to the ID entry
 * screen, not show them a server error.
 *
 * Note what is NOT in the response: the student_id. The link deliberately
 * carries a token instead of an ID because an ID is what `scan` and `enroll`
 * accept, and a forwarded link must not hand one out. submitSummary takes the
 * token in its place.
 */
export function lookupToken(token, date = null, options = {}) {
  const payload = { t: token };
  if (date) payload.date = date;
  return request('lookupToken', payload, options);
}

/**
 * photos: array of data: URLs or {name, mimeType, data} objects.
 *
 * `who` is either {studentId} — the scanned or typed-in path — or {token},
 * for a student who arrived through their emailed link and never saw their ID.
 */
export function submitSummary(who, text, photos = [], sessionDate = null, options = {}) {
  const payload = { text, photos };
  if (typeof who === 'string') payload.student_id = who;
  else if (who && who.token) payload.token = who.token;
  else if (who && who.studentId) payload.student_id = who.studentId;
  else throw new ApiError('submitSummary needs a student id or a summary token', 'config');
  if (sessionDate) payload.session_date = sessionDate;
  return request('submitSummary', payload, options);
}

// --- admin actions ----------------------------------------------------------
// The PIN goes in the body, never a header — a header would trigger the
// preflight described at the top of this file.

export const admin = {
  /**
   * The roster. `slim` asks for id/name/grade/active only — the four columns
   * the admin table draws — and lets the backend skip reading and replaying the
   * event log for statistics the admin page recomputes locally anyway. The
   * tablet's roster prime leaves it off, because it wants currently_in.
   */
  getRoster: (pin, { slim = false } = {}, options = {}) =>
    request('getRoster', { pin, slim }, options),
  /**
   * Sessions. `slim` drops the pre-formatted local clock strings and the
   * per-student totals block; the admin page formats its own times and groups
   * its own totals from rows it already holds.
   */
  /**
   * `includeRejected` asks for sessions the grace-period job took out of the
   * count. They come back carrying event_status ('active' | 'rejected' |
   * 'recovered'); everything the server totals still skips the rejected ones,
   * and so must anything the caller totals.
   */
  getTimesheet: (pin, { from = null, to = null, studentId = null, slim = false,
                        includeRejected = false } = {}, options = {}) =>
    request('getTimesheet', { pin, from, to, student_id: studentId, slim,
                              include_rejected: includeRejected }, options),
  getStudent: (pin, studentId, options = {}) => request('getStudent', { pin, student_id: studentId }, options),
  /** Every summary in one call, or one student's with studentId. */
  getSummaries: (pin, studentId = null, options = {}) =>
    request('getSummaries', studentId ? { pin, student_id: studentId } : { pin }, options),
  /** Appends a tombstone and trashes the photos; the row stays for the record. */
  deleteSummary: (pin, summaryId, reason = '', options = {}) =>
    request('deleteSummary', { pin, summary_id: summaryId, reason }, options),
  /**
   * Appends a correction; the original event row is never modified.
   * Resolves with `sessions`: that student's whole timeline, rebuilt server-side.
   * Superseding a check-in can re-pair the sessions around it, so this is the
   * authoritative answer — patch state with it rather than re-fetching.
   */
  editEvent: (pin, eventId, { timestamp = null, direction = null, reason = '' } = {}, options = {}) =>
    request('editEvent', { pin, event_id: eventId, timestamp, direction, reason }, options),
  /** Appends a tombstone; the original event row is never deleted. Also resolves with `sessions`. */
  deleteEvent: (pin, eventId, reason = '', options = {}) =>
    request('deleteEvent', { pin, event_id: eventId, reason }, options),
  /** Resolves with `student`: the updated roster record, ready to patch in. */
  setActive: (pin, studentId, active, options = {}) =>
    request('setActive', { pin, student_id: studentId, active }, options),
  /**
   * Correct a student's name. Name is roster data, not attendance data — the
   * event log stores only student_id, so a rename changes no hour and no
   * session. Resolves to {student_id, name, previous_name, changed, student}.
   */
  setName: (pin, studentId, name, options = {}) =>
    request('setName', { pin, student_id: studentId, name }, options),
  /**
   * Add or correct an email. Pass '' to clear it, which stops the scan-out
   * emails. Resolves to {student_id, email, previous_email, changed, student}.
   */
  setEmail: (pin, studentId, email, options = {}) =>
    request('setEmail', { pin, student_id: studentId, email }, options),
  /**
   * Write a session by hand — for the night the tablet was down, where there
   * is no scan to correct. `date` is YYYY-MM-DD, `start`/`end` are "HH:mm"
   * local. The server rejects an end before the start, an overlap with a
   * session the student already has, and anything over max_session_minutes.
   * Resolves with `sessions`: that student's rebuilt timeline.
   */
  addManualSession: (pin, studentId, { date, start, end, reason = '' } = {}, options = {}) =>
    request('addManualSession', { pin, student_id: studentId, date, start, end, reason }, options),
  /**
   * Put rejected sessions back into the count. Takes the event ids of both
   * ends of each session, so a bulk recovery is one request. Resolves to
   * {recovered, skipped, sessions_by_student}.
   */
  recoverEvents: (pin, eventIds, options = {}) =>
    request('recoverEvents', { pin, event_ids: eventIds }, options),
  /**
   * Sign off flagged sessions so they leave the Needs review queue. Takes event
   * ids; the server verifies whole sessions, and only ones that are written up.
   * Resolves to {verified, skipped: [{..., reason}], sessions_by_student}.
   */
  verifySessions: (pin, eventIds, options = {}) =>
    request('verifySessions', { pin, event_ids: eventIds }, options),

  // --- teams ---------------------------------------------------------------
  // Teams are a coach-side grouping and nothing else in the app knows they
  // exist. No event, hour or statistic moves when a student changes team, so
  // none of these endpoints touches the event log.
  //
  // getRoster already returns the team list alongside the students, because no
  // view can draw a row without both. These are the writes, plus a standalone
  // read for member counts.

  /** Resolves to {teams: [{team_id, name, created_at, member_count}], unassigned_count}. */
  getTeams: (pin, options = {}) => request('getTeams', { pin }, options),
  /** Resolves to {team, teams}. Duplicate names are rejected server-side. */
  createTeam: (pin, name, options = {}) => request('createTeam', { pin, name }, options),
  /** One cell. Members carry the id, not the name, so nobody moves. Resolves to {team, teams}. */
  renameTeam: (pin, teamId, name, options = {}) =>
    request('renameTeam', { pin, team_id: teamId, name }, options),
  /** Members fall back to Unassigned in the same lock. Resolves to {teams, unassigned}. */
  deleteTeam: (pin, teamId, options = {}) => request('deleteTeam', { pin, team_id: teamId }, options),
  /**
   * Put students on a team. `students` is one id or an array of them, so
   * assigning a whole subteam is one request and one column write. Pass an
   * empty teamId to move them back to Unassigned — a normal answer, not an
   * error. Resolves to {team_id, changed, students}.
   */
  setTeam: (pin, students, teamId, options = {}) =>
    request('setTeam', { pin, student_ids: Array.isArray(students) ? students : [students],
                         team_id: teamId || '' }, options),
};

// --- health -----------------------------------------------------------------

/** GET the deployment's health check. Handy for a "is the backend up?" badge. */
export async function health(options = {}) {
  const url = await apiUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const body = await res.json();
    if (body.ok === false) throw new ApiError(String(body.error), 'server');
    return body.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('could not reach the server', 'network', err);
  } finally {
    clearTimeout(timer);
  }
}

/** The QR payload is a bare 7-digit number and nothing else. */
export function isValidStudentId(value) {
  return /^\d{7}$/.test(String(value ?? '').trim());
}
