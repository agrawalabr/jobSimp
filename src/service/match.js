// Resume↔JD matching. Pure functions, unit-testable — no I/O.
// Shared by SW + widget (ESM content bootstrap).

// Split raw skill strings on common separators: , / | ; • · and newlines.
export function splitSkills(raw) {
  const items = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s || '').split(/[,/|;•·\n\t]+|\s{2,}/))
    .map((s) => s.replace(/^[\s\-–—:()\[\]]+|[\s\-–—:()\[\]]+$/g, ''))
    .filter((s) => s.length > 1 && s.length <= 40 && !/^(etc|and|or|with)$/i.test(s));
  const seen = new Set(); const out = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

function skillRegex(skill) {
  const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zA-Z0-9])${esc}([^a-zA-Z0-9]|$)`, 'i');
}

/** Resume-centric overlap: % of resume skills found in JD. */
export function matchScore(jdText, skills) {
  const jd = String(jdText || '');
  const list = splitSkills(skills);
  if (!jd.trim() || !list.length) return { score: 0, matched: [], missing: list };
  const matched = [], missing = [];
  for (const s of list) (skillRegex(s).test(jd) ? matched : missing).push(s);
  const denom = Math.min(list.length, 25);
  return { score: Math.round(Math.min(matched.length / denom, 1) * 100), matched, missing };
}

/** Canonical skill + aliases. First term is displayed. */
export const SKILL_DICT = [
  ['Python'], ['SQL', 'Structured Query Language'], ['Java'], ['JavaScript', 'JS'], ['TypeScript', 'TS'],
  ['Scala'], ['Golang'], ['Rust'], ['C++'], ['C#'], ['Ruby'], ['PHP'], ['Kotlin'], ['Swift'], ['MATLAB'],
  ['Bash', 'Shell'], ['PowerShell'],
  ['Spark', 'Apache Spark', 'PySpark'], ['Hadoop'], ['Kafka', 'Apache Kafka'], ['Flink', 'Apache Flink'],
  ['Airflow', 'Apache Airflow'], ['dbt', 'data build tool'], ['Snowflake'], ['Databricks'], ['Redshift'],
  ['BigQuery'], ['Trino', 'Presto'], ['Hive'], ['ETL', 'Extract Transform Load'], ['ELT', 'Extract Load Transform'],
  ['Data Warehousing', 'Warehousing', 'Data Warehouse'], ['Data Modeling'], ['Data Pipelines'],
  ['Streaming', 'Stream Processing'], ['Batch Processing'], ['Data Engineering'], ['Distributed Systems'],
  ['AWS', 'Amazon Web Services'], ['GCP', 'Google Cloud Platform', 'Google Cloud'], ['Azure', 'Microsoft Azure'],
  ['S3'], ['EC2'], ['RDS'], ['AWS Lambda'], ['DynamoDB'], ['AWS Glue', 'Glue'], ['EMR'], ['Kinesis'],
  ['Docker'], ['Kubernetes', 'K8s'], ['Terraform'], ['Ansible'],
  ['CI/CD', 'CICD', 'Continuous Integration', 'Continuous Delivery'], ['Jenkins'], ['GitHub Actions'], ['GitLab CI'],
  ['Linux'], ['Git'], ['Platform Engineering'], ['DevOps'], ['MLOps'],
  ['PostgreSQL', 'Postgres'], ['MySQL'], ['MongoDB'], ['Cassandra'], ['Redis'], ['Elasticsearch'],
  ['Oracle'], ['SQL Server'], ['NoSQL'],
  ['React', 'React.js'], ['Angular'], ['Vue', 'Vue.js'], ['Node.js', 'NodeJS'], ['Express'], ['Django'],
  ['Flask'], ['FastAPI'], ['Spring Boot', 'Spring'], ['.NET'], ['GraphQL'], ['REST', 'RESTful', 'REST API'], ['gRPC'],
  ['Machine Learning', 'ML'], ['Deep Learning'], ['TensorFlow'], ['PyTorch'], ['scikit-learn', 'sklearn'],
  ['Pandas'], ['NumPy'], ['NLP', 'Natural Language Processing'], ['Computer Vision'], ['LLM', 'Large Language Models'],
  ['Tableau'], ['Power BI', 'PowerBI'], ['Looker'], ['Microservices'], ['Agile', 'Scrum'], ['Jira'], ['System Design'],
];

/** Requirements this JD asks for (dict entries whose canonical/alias appears in the JD). */
export function jdRequirements(jdText) {
  const t = String(jdText || '');
  return SKILL_DICT.filter((entry) => entry.some((term) => skillRegex(term).test(t)));
}

/**
 * JD-directional match: matched = JD needs the resume covers; missing = JD gaps.
 * Returns null if the JD has no recognizable skills (caller may fall back to matchScore).
 */
export function jdMatch(jdText, resumeSkills) {
  const req = jdRequirements(jdText);
  if (!req.length) return null;
  const resumeText = (Array.isArray(resumeSkills) ? resumeSkills : [resumeSkills]).join(' \n ');
  const matched = [], missing = [];
  for (const entry of req) {
    const has = entry.some((term) => skillRegex(term).test(resumeText));
    (has ? matched : missing).push(entry[0]);
  }
  return { score: Math.round((matched.length / req.length) * 100), matched, missing };
}

/** Prefer JD-directional score; fall back to resume-centric overlap. */
export function scoreJdAgainstResume(jdText, resumeSkills) {
  return jdMatch(jdText, resumeSkills) || matchScore(jdText, resumeSkills);
}

export function looksLikeJD(text) {
  const t = String(text || '').toLowerCase();
  if (t.length < 400) return false;
  const signals = ['responsibilities', 'qualifications', 'requirements', 'what you’ll do', "what you'll do",
    'about the role', 'we are looking for', 'minimum qualifications', 'preferred qualifications',
    'equal opportunity', 'years of experience', 'apply now', 'job description', 'benefits', 'who you are'];
  let hits = 0;
  for (const s of signals) if (t.includes(s)) hits++;
  return hits >= 2;
}
