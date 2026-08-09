// Single source of truth for shared enums / dashboard config.
// Consumed by schema (src/dao/dbModel.js), dashboard UI, and compose vendor
// (fonts/sizes). Content scripts can't import ES modules — they keep local
// literals, but the string values here are canonical.

/* ── Job tracker ───────────────────────────────────────────────────────── */

export const YES = 'Yes';
export const NO = 'No';
export const UNKNOWN = 'Unknown';

/** Application pipeline stages. First entry is the default for a freshly saved job. */
export const JOB_STATUSES = Object.freeze([
  'To Apply', 'Applied', 'OA', 'Phone Screen', 'Interview',
  'Final Round', 'Offer', 'Rejected', 'Ghosted', 'Withdrawn',
]);

export const JOB_STATUS = Object.freeze({
  TO_APPLY: 'To Apply',
  APPLIED: 'Applied',
  OA: 'OA',
  PHONE_SCREEN: 'Phone Screen',
  INTERVIEW: 'Interview',
  FINAL_ROUND: 'Final Round',
  OFFER: 'Offer',
  REJECTED: 'Rejected',
  GHOSTED: 'Ghosted',
  WITHDRAWN: 'Withdrawn',
});

/** Statuses that count as "in an active pipeline" (stats + response-rate math). */
export const ACTIVE_STATUSES = Object.freeze([
  JOB_STATUS.OA, JOB_STATUS.PHONE_SCREEN, JOB_STATUS.INTERVIEW, JOB_STATUS.FINAL_ROUND,
]);

/** Statuses that count toward response rate (active + terminal replies). */
export const RESPONSE_STATUSES = Object.freeze([
  ...ACTIVE_STATUSES, JOB_STATUS.OFFER, JOB_STATUS.REJECTED,
]);

/** Employment type. First entry is the default when nothing is detected. */
export const EMPLOYMENT_TYPES = Object.freeze([
  UNKNOWN, 'Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary',
]);

/** Yes/No/Unknown fields — sponsorship and E-Verify. First entry is the default. */
export const TRISTATE = Object.freeze([UNKNOWN, YES, NO]);

/** Referral flag. First entry is the default. */
export const REFERRAL = Object.freeze([NO, YES]);

/* ── Dashboard tabs ────────────────────────────────────────────────────── */

export const TAB = Object.freeze({
  TRACKER: 'tracker',
  OUTREACH: 'outreach',
  PROFILE: 'profile',
  RESUME: 'resume',
  SETTINGS: 'settings',
});

export const MAIN_TABS = Object.freeze([TAB.TRACKER, TAB.OUTREACH]);
export const ACCOUNT_TABS = Object.freeze([TAB.PROFILE, TAB.RESUME, TAB.SETTINGS]);
export const DEFAULT_TAB = TAB.TRACKER;

/* ── Profile field keys ────────────────────────────────────────────────── */

export const PROFILE_CONTACT_KEYS = Object.freeze(['phone', 'address']);
export const PROFILE_LINK_KEYS = Object.freeze(['linkedin', 'github', 'portfolio']);
export const PROFILE_METRIC_KEYS = Object.freeze([
  'workAuth', 'needsSponsorship', 'salaryExpectation',
  'relocation', 'ethnicity', 'veteranStatus', 'disabilityStatus',
]);

/* ── Email / signatures ────────────────────────────────────────────────── */

export const EMAIL_STATUS = Object.freeze({
  SENT: 'sent',
  FAILED: 'failed',
  DRAFT: 'draft',
});

/** Signature picker sentinel — no signature inserted. */
export const SIG_NONE = 'none';
/** Legacy choice id from older builds; treat as active signature. */
export const SIG_LEGACY_DEFAULT = 'default';

export const DEFAULT_EMAIL_TONE = 'concise, warm, confident';
export const DEFAULT_OUTREACH_CONTEXT =
  'Generic cold outreach — introduce yourself and ask for a brief chat.';

/* ── Resume / attachments MIME ─────────────────────────────────────────── */

export const MIME = Object.freeze({
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TXT: 'text/plain',
  OCTET: 'application/octet-stream',
});

/** `<input accept>` for resume upload. */
export const RESUME_ACCEPT = Object.freeze([
  '.pdf', '.docx', '.txt', MIME.PDF, MIME.TXT, MIME.DOCX,
]).join(',');

/* ── Compose Quill UI data (see compose-ui.js → font/size/utils modules) ─ */

export { COMPOSE_FONTS, COMPOSE_BLOCKS, COMPOSE_COLORS } from './compose-ui.js';
