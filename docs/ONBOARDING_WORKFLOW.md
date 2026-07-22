# Onboarding workflow

End-to-end path for first-time setup: UI in `src/component/onboarding`, logic in `src/service`, config in `src/static`.

## Flow

```mermaid
flowchart TD
  Start[Extension install / open onboarding]
  S1[Step1 Google sign-in]
  S2[Step2 AI provider + key + model]
  S3[Step3 Upload or paste resume]
  Parse[Parse with LLM]
  Edit[Edit parsed fields]
  Save[Save parsed + build graph]
  Finish[Finish onboarding]
  Dash[Dashboard]

  Start --> S1
  S1 -->|oauth + dao.upsertUser| S2
  S2 -->|dao settings + secrets| S3
  S3 -->|dao.saveResume| Parse
  Parse -->|service/resume + llm + prompts| Edit
  Edit -->|dao.saveParsedResume| Save
  Save -->|graph blob + activeResumeId| Finish
  Finish -->|settings.onboarded + profile/metrics| Dash
```

## Storage

All domain data is IndexedDB `jobsimp-graph` via [`src/dao/`](../src/dao/). See [`DATABASE.md`](./DATABASE.md).

| Store | Holds |
|---|---|
| `settings` | provider, model, gmail, emailTemplate, onboarded, widgetResumeId |
| `secrets` | llmKeys, accessToken, expiresAt, sessionExpiresAt |
| `user` / `profile` / `metrics` | identity + contact + EEO |
| `resume` / `graph` | resumes + derived graphs |

## Manual test checklist

1. Load unpacked → onboarding opens.
2. Sign in → Next → enter AI key → upload resume → Parse → Save → Finish.
3. DevTools → IndexedDB `jobsimp-graph` → `settings:current.onboarded === true`, `secrets:current.llmKeys` has key.
