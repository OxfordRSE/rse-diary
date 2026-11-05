// Served at /api/instructions. The reader is an LLM agent acting for the user.
export const INSTRUCTIONS = `# RSE diary: instructions for agents

You are logging work to the user's personal RSE dev diary. Base URL: \`$RSE_DIARY_URL\`.
Authenticate every request with \`Authorization: Bearer $RSE_DIARY_TOKEN\`.

## What an entry is

- One project, one day, one amount, short notes.
- **fte**: fraction of a working day spent on the project (0.25 = a quarter day). Must be > 0 and <= 1.
  Estimate it from the conversation if the user doesn't say, and tell the user what you logged.
- **Touch**: if the user worked on it but the amount is unknown, omit \`fte\` (or send \`null\`).
- **notes**: a few short bullet points of what was done. Plain text / markdown. No secrets.
- **date**: \`YYYY-MM-DD\`; defaults to today (Europe/London).
- Several entries for the same project on the same day are fine; they add up.
- Non-project work (admin, training, email, meetings) goes to the built-in **Overheads** project.

## Steps

1. \`GET /api/projects\` to see existing project names. Prefer an existing project.
2. \`POST /api/entries\` with one entry or an array of entries.
   - Identify the project by \`project\` (name, matched ignoring case and punctuation) or \`project_id\`.
   - To create a new project, add \`"create_project": true\` to that entry. If a matching project
     already exists it is used instead; nothing is duplicated.
   - Optional \`client_id\` (e.g. a conversation id): re-posting the same \`client_id\` for the same
     date updates that entry instead of adding another. Use it when updating your own earlier log.
3. Read the response: \`warnings\` (e.g. a day over 1.0 FTE) are worth mentioning to the user.

\`\`\`sh
curl -sS -X POST "$RSE_DIARY_URL/api/entries" \\
  -H "Authorization: Bearer $RSE_DIARY_TOKEN" -H "Content-Type: application/json" \\
  -d '[
    {"project": "RSE diary", "create_project": true, "fte": 0.25,
     "notes": "- Designed storage layout\\n- Wrote API tests"},
    {"project": "Glow", "fte": 0.1, "notes": "Answered emails on the data integrity and security model."}
  ]'
\`\`\`

A 422 response lists problems per entry; for an unknown project it includes \`suggestions\`.
Nothing is written when any entry is invalid, so fix and resend the whole request.

## Other endpoints

- \`POST /api/projects\` \`{name, estimate_fte_days?, start?, deadline?}\`; \`PATCH /api/projects/{id}\`
- \`GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&project=<id>\`
- \`PATCH /api/entries/{id}\` (any of date, project_id, fte, notes); \`DELETE /api/entries/{id}\`
`;
