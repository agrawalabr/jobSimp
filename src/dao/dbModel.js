// Schema only (DDL). No IndexedDB / network I/O here.
//
// IndexedDB `jobsimp-graph` (v3+) — one object store per domain type:
//   user · profile · metrics · resume · graph · job · answer · email ·
//   discovered · settings · secrets · meta · entities
//
// settings/secrets live in IndexedDB (Story B). ExtStorage domain usage retired.

import { JOB_STATUSES, EMPLOYMENT_TYPES, TRISTATE, REFERRAL } from '../static/enums.js';

/** Entity type strings (= object store names for domain data). */
export const TYPES = Object.freeze({
  USER: 'user',
  PROFILE: 'profile',
  METRICS: 'metrics',
  RESUME: 'resume',
  GRAPH: 'graph',
  JOB: 'job',
  ANSWER: 'answer',
  EMAIL: 'email',
  DISCOVERED: 'discovered',
  SETTINGS: 'settings',
  SECRETS: 'secrets',
});

/**
 * Object store name for each type (1:1 with TYPES today).
 * `meta` and `entities` are extra stores managed by dao.
 */
export const STORES = Object.freeze({
  [TYPES.USER]: 'user',
  [TYPES.PROFILE]: 'profile',
  [TYPES.METRICS]: 'metrics',
  [TYPES.RESUME]: 'resume',
  [TYPES.GRAPH]: 'graph',
  [TYPES.JOB]: 'job',
  [TYPES.ANSWER]: 'answer',
  [TYPES.EMAIL]: 'email',
  [TYPES.DISCOVERED]: 'discovered',
  [TYPES.SETTINGS]: 'settings',
  [TYPES.SECRETS]: 'secrets',
  META: 'meta',
  ENTITIES: 'entities', // legacy dump / reserved
});

/** All domain store names (for onupgradeneeded). */
export const DOMAIN_STORES = Object.freeze(Object.values(TYPES));

export const storeFor = (type) => STORES[type] || STORES.ENTITIES;

export const SINGLETONS = Object.freeze({
  USER: `${TYPES.USER}:current`,
  PROFILE: `${TYPES.PROFILE}:current`,
  METRICS: `${TYPES.METRICS}:current`,
  SETTINGS: `${TYPES.SETTINGS}:current`,
  SECRETS: `${TYPES.SECRETS}:current`,
});

export const META_KEYS = Object.freeze({
  ACTIVE_RESUME: 'activeResumeId',
  EXT_STORAGE_MIGRATED: 'extStorageMigrated',
});

export const KINDS = Object.freeze({
  RESUME: 'resume',
  EXPERIENCE: 'experience',
  PROJECT: 'project',
  BULLET: 'bullet',
  SKILL: 'skill',
  EDUCATION: 'education',
  CERTIFICATION: 'certification',
});

export const RELS = Object.freeze({
  HAS: 'HAS',
  MENTIONS: 'MENTIONS',
  DEMONSTRATES: 'DEMONSTRATES',
});

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const newResumeId = () => `${TYPES.RESUME}:${uuid()}`;
export const newJobId = () => `${TYPES.JOB}:${uuid()}`;
export const newAnswerId = () => `${TYPES.ANSWER}:${uuid()}`;
export const newEmailId = () => `${TYPES.EMAIL}:${uuid()}`;
export const graphEntityId = (resumeId) => `${TYPES.GRAPH}:${resumeId}`;
export const normSkill = (s) => String(s || '').toLowerCase().trim();

// ---- empty / default payloads ----
export function emptyUser({ email = '', name = '', picture = '', signedInAt = 0 } = {}) {
  return { email, name, picture, signedInAt };
}

export function emptyProfile({ phone = '', address = '', links = null } = {}) {
  return {
    phone,
    address,
    links: links || { linkedin: '', github: '', portfolio: '', other: [] },
  };
}

export function emptyMetrics(partial = {}) {
  return {
    ethnicity: '',
    veteranStatus: '',
    disabilityStatus: '',
    workAuth: '',
    needsSponsorship: '',
    salaryExpectation: '',
    relocation: '',
    ...partial,
  };
}

export function emptyResume(partial = {}) {
  return {
    name: '',
    mime: 'text/plain',
    dataB64: '',
    text: '',
    parsed: null,
    isDefault: false,
    createdAt: Date.now(),
    parsedAt: null,
    ...partial,
  };
}

export function emptyGraph(resumeId, partial = {}) {
  return {
    resumeId,
    nodes: [],
    edges: [],
    builtAt: null,
    ...partial,
  };
}

export function emptyJob(partial = {}) {
  return {
    date: new Date().toISOString().slice(0, 10),
    company: '',
    role: '',
    type: EMPLOYMENT_TYPES[0],
    status: JOB_STATUSES[0],
    sponsorship: TRISTATE[0],
    everify: TRISTATE[0],
    followup: '',
    referral: REFERRAL[0],
    url: '',
    location: '',
    salary: '',
    datePosted: '',
    source: '',
    notes: '',
    jdText: '',
    externalJobId: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  };
}

export function emptySettings(partial = {}) {
  return {
    provider: 'gemini',
    model: '',
    gmail: { enabled: true, fromName: '' },
    emailTemplate: { tone: 'concise, warm, confident', signature: '' },
    onboarded: false,
    widgetResumeId: null,
    ...partial,
  };
}

export function emptySecrets(partial = {}) {
  return {
    llmKeys: { gemini: '', claude: '', openai: '' },
    accessToken: '',
    expiresAt: 0,
    sessionExpiresAt: 0,
    ...partial,
  };
}

export const FIELDS = Object.freeze({
  [TYPES.USER]: ['email', 'name', 'picture', 'signedInAt'],
  [TYPES.PROFILE]: ['phone', 'address', 'links'],
  [TYPES.METRICS]: [
    'ethnicity', 'veteranStatus', 'disabilityStatus',
    'workAuth', 'needsSponsorship', 'salaryExpectation', 'relocation',
  ],
  [TYPES.RESUME]: ['name', 'mime', 'dataB64', 'text', 'parsed', 'isDefault', 'createdAt', 'parsedAt'],
  [TYPES.GRAPH]: ['resumeId', 'nodes', 'edges', 'builtAt'],
  [TYPES.JOB]: [
    'date', 'company', 'role', 'type', 'status', 'sponsorship', 'everify',
    'followup', 'referral', 'url', 'location', 'salary', 'datePosted', 'source',
    'notes', 'jdText', 'createdAt', 'updatedAt',
  ],
  [TYPES.ANSWER]: ['question', 'answer', 'patterns', 'type', 'useCount'],
  [TYPES.EMAIL]: [
    'jobId', 'to', 'subject', 'body', 'provider', 'status',
    'gmailId', 'sentAt', 'createdAt', 'error',
  ],
  [TYPES.SETTINGS]: [
    'provider', 'model', 'gmail', 'emailTemplate', 'onboarded', 'widgetResumeId',
  ],
  [TYPES.SECRETS]: ['llmKeys', 'accessToken', 'expiresAt', 'sessionExpiresAt'],
});

export function pickFields(type, obj = {}) {
  const allow = FIELDS[type];
  if (!allow) return { ...obj };
  const out = {};
  for (const k of allow) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
