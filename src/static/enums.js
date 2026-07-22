// Single source of truth for JOB tracker enums.
// Consumed by the schema (src/dao/dbModel.js) and the dashboard UI
// (src/component/dashboard/dashboard.js). Content scripts (scraper.js /
// widget.js) are classic scripts and can't import ES modules, so they keep
// their own literals — but the string values here are the canonical set.

/** Application pipeline stages. First entry is the default for a freshly saved job. */
export const JOB_STATUSES = Object.freeze([
  'To Apply', 'Applied', 'OA', 'Phone Screen', 'Interview',
  'Final Round', 'Offer', 'Rejected', 'Ghosted', 'Withdrawn',
]);

/** Statuses that count as "in an active pipeline" (stats + response-rate math). */
export const ACTIVE_STATUSES = Object.freeze(['OA', 'Phone Screen', 'Interview', 'Final Round']);

/** Employment type. First entry ('Unknown') is the default when nothing is detected. */
export const EMPLOYMENT_TYPES = Object.freeze([
  'Unknown', 'Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary',
]);

/** Yes/No/Unknown fields — sponsorship and E-Verify. First entry is the default. */
export const TRISTATE = Object.freeze(['Unknown', 'Yes', 'No']);

/** Referral flag. First entry is the default. */
export const REFERRAL = Object.freeze(['No', 'Yes']);
