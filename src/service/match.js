// DEPRECATED / UNUSED. Local keyword + skill-dictionary matching has been retired
// in favour of the LLM doing all matching, scoring and analysis in one call
// (see the `jd.analyze` handler in the service worker + JD_ANALYSIS_PROMPT).
// Nothing imports this module anymore. Safe to delete.
//
// Note: `looksLikeJD` still exists as a small internal copy inside
// src/service/scraper.js (page classifier), and `splitSkills` inside
// src/dao/graph.js — both self-contained, unrelated to this file.
export {};
