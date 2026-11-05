# RSE Diary — design

Date: 2026-11-05
Status: approved for build ("if no urgent questions, begin the build"); [my call] items open to later review

Notation: **[decided]** = the user said so. **[my call]** = chosen by the designer (Claude) without explicit user input; reviewable. **[builder]** = left to the builder.

## 1. Intent

A personal dev diary for Research Software Engineers who juggle several projects at once. Each RSE logs, per day, which projects they worked on, roughly how much (fraction of an FTE day), and short notes on what they did. It is a lab notebook for RSE work, not a timesheet.

Why: an RSE's week is split across many projects plus overheads, and nobody (including the RSE) has a clear picture of where the time went or how a project is tracking against its estimate. Git logs are a poor progress view. The diary gives the RSE an at-a-glance view of their working pattern and per-project progress, and lets them hand over evidence (FTE totals, a narrative log) when someone asks.

The main way entries get in is **AI agents**. On a normal day the user never opens the app; they tell whichever agent session they're in (e.g. Claude Code) to "log this: new project RSE diary, 0.25 FTE, a few bullets on what we did, and also 0.1 FTE on Glow answering emails about the security model". Several sessions may log to the same day independently. The web UI is for reviewing, editing, presenting and exporting.

Originating user: an RSE (Oxford). Built for themself first; teammates can sign up if they find it useful.

## 2. Goals

1. Agents can log entries with a long-lived personal token, including creating projects, without the user opening the app. [decided]
2. Entries: date, project, FTE fraction of that day **or** a "touch" (worked on it, amount unknown), free-text notes, source. [decided]
3. Projects have optional estimate (FTE-days), start date, deadline. Running totals vs estimate. [decided]
4. A built-in "Overheads / outside work" bucket for non-project work. [decided]
5. Overview page: calendar heatmap of working pattern, the selected day's entries, project list with sparklines and progress vs estimate, filterable to a subset of projects. [decided]
6. Project page: calendar spanning the project's life, summary, scrollable diary of entries, exports. [decided]
7. Exports: summary for an administrator (FTE per project; notes excluded); per-project diary as `.log` and `.json`. [decided]
8. Entries editable in the web UI after the fact. [decided]
9. Data survives app redeploys; app can be redeployed whenever. [decided]
10. Cheap: target under ~$5/month for a handful of users. [decided: "keep costs pretty low"; number is my call]

## 3. Non-goals

- Team/admin oversight, managers viewing others' logs, shared projects across users. [decided]
- Multi-tenancy beyond "each user is an isolated silo". [decided]
- Timers, reminders, notifications, git integration, calendar integration.
- An MCP server (v1). The REST API + an instructions file is enough; MCP can wrap it later. [my call]
- Encryption/anonymisation beyond AWS defaults. AWS account admins being able to read data is acceptable. [decided]
- Estimating FTE for touched days (spreading remaining time). Deferred until needed. [decided]

## 4. Anti-goals (would make it a failure even if it works)

- Any page or action that requires JavaScript or CSS to function. [decided]
- Anyone other than the user being able to read their entries via the app. [decided]
- Losing data on an app redeploy. [decided]
- Logging that feels like timesheet bureaucracy — agents must be able to log in one call with minimal ceremony; validation warns rather than blocks where it can.
- Agents silently creating duplicate projects ("Glow" vs "glow").

## 5. Constraints

- AWS (org uses it heavily). [decided] Region eu-west-2 (London). [my call]
- No managed relational DB; storage is S3 JSON. [decided]
- Infrastructure as code: **Terraform**. [decided]
- Languages: HTML + CSS + **TypeScript** (JS only if unavoidable). [decided]
- Web rules [decided]:
  - Works and renders acceptably with JS and CSS both disabled.
  - CSS and JS progressively enhance.
  - Mobile first, works on desktop.
  - Semantic HTML and native elements (`<details name=…>` accordions, `<dialog>` modals, `<meter>`/`<progress>`, `<time>`, real `<table>`s, plain `<form>` GET/POST).
  - A plain CSS UI library is fine. [decided] Use **Pico CSS** (classless-friendly, semantic). [my call]
  - Some reactivity is fine as long as no-JS still works.
- Auth: Cognito user pool, accounts created by an admin (no self-signup) for now; SAML2 SSO may be added later. [decided]

## 6. Architecture [my call unless marked]

```
Browser ──HTML/forms, session cookie──┐
                                      ├─ CloudFront ─┬─ /static/*  → S3 (assets bucket)
Agent ──JSON, Bearer PAT─────────────┘              └─ everything else → Lambda (function URL)
                                                                         │
Cognito user pool (managed login) ◄── OAuth code flow ───────────────────┤
                                                                         ▼
                                                             S3 data bucket (JSON)
```

- **One Lambda** (Node.js 22, TypeScript, bundled with esbuild) does everything: server-rendered HTML pages, form POST handling (POST-redirect-GET), and the JSON API under `/api/`. No framework required; HTML via tagged template literals with mandatory escaping. [builder may pick a tiny router/templating lib]
- **Static assets** (Pico CSS, app CSS, compiled enhancement TS) in a separate S3 bucket behind the same CloudFront distribution.
- **Server-side rendering is required** because of the no-JS rule. [follows from decided constraint]
- Custom domain: optional; CloudFront default domain is fine to start. [builder]

### Two Terraform root modules, separate state

- `infra/persistent/`: data S3 bucket (versioning on, `prevent_destroy`, SSE-S3, public access blocked), Cognito user pool + app client + managed-login domain. These must never be destroyed by an app deploy.
- `infra/app/`: Lambda, function URL, IAM role (read/write only the data bucket), assets bucket, CloudFront. Freely redeployable/destroyable. Reads persistent outputs via `terraform_remote_state` or variables.
- Terraform state backend: S3 backend with locking. [builder; ask the user for an existing state bucket if one exists, otherwise create one]

## 7. Auth

### Humans (web)
- Cognito managed login, OAuth2 authorization-code flow with PKCE, handled entirely server-side (works without JS).
- After callback, the Lambda sets `HttpOnly; Secure; SameSite=Lax` cookies holding the Cognito tokens (or a signed session referencing them) and refreshes with the refresh token when the ID/access token expires. [builder: exact cookie mechanics]
- The user's identity is the Cognito `sub`. All data is keyed by it.
- CSRF: `SameSite=Lax` + check `Origin`/`Sec-Fetch-Site` on state-changing POSTs.
- Self-signup disabled; users created with `AdminCreateUser` (document the CLI command in the README).
- SAML later: add the IdP to the same user pool. Federated users get a new `sub`; a one-off script to move a user's prefix (`users/{old}/` → `users/{new}/`) is enough. Not built in v1. [my call]

### Agents (API)
- **Personal access tokens (PATs)**, created on a "Tokens" page: user gives it a label (e.g. "laptop"), token shown once, format `rsed_` + 32 random bytes base64url.
- Stored as `tokens/{sha256(token)}.json` → `{sub, label, created_at, last_used_at, expires_at|null}`. Listed on the Tokens page via a per-user index (`users/{sub}/tokens.json` holding hashes + labels). Revocable.
- One scope: full read/write to the owner's own data via `/api/*`. [my call]
- Sent as `Authorization: Bearer rsed_…`.
- One token per machine, set once (e.g. `RSE_DIARY_TOKEN` env var), shared by all agent sessions on that machine. [decided in spirit: "set up once"]

## 8. Storage (S3 JSON)

```
users/{sub}/config.json            # projects + user settings
users/{sub}/entries/{YYYY-MM}.json # { entries: Entry[] } for that month
users/{sub}/tokens.json            # token index for the Tokens page
tokens/{sha256}.json               # PAT lookup
```

- **Concurrency:** several agent sessions plus the web UI can write the same month file at once. Every write is read → modify → `PutObject` with `If-Match: <etag>` (or `If-None-Match: *` when creating); on 412, re-read and retry (up to ~5 times with jitter). Same for `config.json`. This is the one correctness-critical piece; it needs tests.
- Bucket versioning gives undo/audit for free.
- All totals are computed on read; nothing derived is stored. Overview reads ~6 month files + config; fine at personal scale. `shortcut:` cache if it ever gets slow.
- Entries are immutable-id records; edits replace by id, deletes remove by id.

## 9. Data model

```ts
type Project = {
  id: string;              // short slug-ish id, stable
  name: string;            // unique per user, case-insensitive
  colour: string;          // from fixed palette, auto-assigned, editable
  kind: "project" | "overhead";
  estimate_fte_days?: number;
  start?: string;          // YYYY-MM-DD
  deadline?: string;       // YYYY-MM-DD
  archived?: boolean;
  created_at: string;
};

type Entry = {
  id: string;              // ULID
  date: string;            // YYYY-MM-DD (user's local date)
  project_id: string;
  fte: number | null;      // 0 < fte <= 1; null means "touch"
  notes: string;           // markdown-ish plain text; may be empty
  source: string;          // "web" | "agent:<label>" e.g. "agent:claude-code"
  created_at: string;
  updated_at: string;
};
```

- A **touch** is `fte: null`. [decided concept; representation my call]
- Multiple entries for the same project on the same day are allowed and summed. [my call — each agent session adds its own entry]
- A day's FTE total over 1.0 shows a warning; never blocked. [my call]
- **Overheads** project (`kind: "overhead"`) exists for every user from first login, cannot be deleted, can be renamed; no estimate by default.
- Project colours: a fixed categorical palette with no greys; the calendar shade uses a neutral grey/ink ramp so it never clashes with a project dot. [decided: "pick a colour that doesn't clash"; ramp choice my call]

## 10. JSON API (for agents)

All under `/api/`, Bearer PAT (session cookie also accepted).

- `GET /api/projects` → projects incl. totals (logged FTE-days, touched days, estimate).
- `POST /api/projects` → create `{name, estimate_fte_days?, start?, deadline?}`; 409 if the name exists (case-insensitive), returning the existing project.
- `PATCH /api/projects/{id}`.
- `POST /api/entries` → body is one entry **or an array** (the example request logs two projects at once). Each item identifies its project by `project_id` **or** `project` (name, case-insensitive exact match). Unknown name → 422 with the closest existing names, unless `"create_project": true` is set on that item. `date` defaults to today; `fte` omitted or null = touch; `source` defaults to `"agent:<token label>"`. All-or-nothing per request.
- `GET /api/entries?from&to&project` ; `PATCH /api/entries/{id}` ; `DELETE /api/entries/{id}`.
- `GET /api/instructions` → a short markdown guide for agents (what fields mean, how FTE works, "list projects first", "prefer existing names", example curl). The README also tells the user how to point their agent at it (e.g. a Claude Code skill / CLAUDE.md snippet that says "to log work, read $RSE_DIARY_URL/api/instructions"). [my call]
- Errors are JSON `{error, detail}` with helpful text — the reader is an LLM.

## 11. Web UI

General: server-rendered pages; every action is a link or a form. No-JS/no-CSS rendering must be readable (real tables, headings, lists). JS (compiled TS, one small module) enhances only.

### 11.1 Overview `/`
Query params: `day=YYYY-MM-DD` (selected day, default today), `p=<id>` repeatable (project subset; default all non-archived).

1. **Working-pattern calendar** (GitHub-style), last 26 weeks [my call] for the selected projects.
   - A real `<table>` with header cells for days (Mon–Sun, 7 rows incl. weekends [my call]) and weeks. Each cell: a link to `?day=…` containing the total FTE as text and the list of projects worked that day (visually hidden when CSS is on).
   - With CSS: ~22px rounded square; background = neutral ramp by total FTE (touch-only days get the lightest non-empty shade); one coloured dot per project worked (FTE or touch); **5+ projects → ✨** instead of dots. Today outlined; selected day outlined distinctly.
   - Layout: desktop = weeks as columns (horizontal, like GitHub), scrolled to the right end. Mobile = transposed, weeks as rows, 7 columns, vertical scroll. [decided: "transmute the table"] Source order is the builder's choice as long as both CSS layouts work and the no-CSS table is readable.
   - Native `title` tooltip per cell (date, per-project FTE/touch).
   - Legend of project colours.
2. **Selected day's entries** directly below the calendar (default today), each with edit link; "Add entry" form/link for that day. With JS, clicking a calendar day swaps this list in place (fetch the same page, replace the fragment, `history.pushState`). [decided]
3. **Project list**: each row has a checkbox (part of a GET form that sets `p=`), name (link to project page), start → deadline, a **sparkline** of weekly FTE (server-rendered inline SVG with a text alternative), and progress vs estimate using `<meter>` (turns warning colour ≥90%; over 100% clearly shown). Overheads shown with total only. "Show selected" submits the form; "Export summary" link uses the same selection.
   - Archived projects hidden behind a `<details>`.

### 11.2 Project page `/projects/{id}`
- Header: name, dates, `x / y FTE-days`, % used, touched days count, time to deadline if any. Edit project via `<dialog>` with JS / separate page without.
- **Full-span calendar**: from `start` (or first entry if no start) to `deadline` (or today if none). Future days drawn as empty dashed cells. Work **before start** and **after deadline** each collapsed into one summary cell at either end (FTE-days + touch count). [decided] Same table/CSS approach as overview, project colour instead of neutral ramp. [my call]
- Exports: `.log`, `.json`.
- **Diary**: entries newest first, scrollable, each editable/deletable. Paginate by month without JS ("older" link); optional infinite scroll with JS. [my call]

### 11.3 Other pages
- Entry add/edit form (date, project select, FTE number or "touch" checkbox, notes textarea). Delete with confirm (`<dialog>` with JS, confirm page without).
- Projects: create/edit/archive.
- Tokens: create (show once), list, revoke.
- Sign-in/out via Cognito managed login.

## 12. Exports

### Summary (for an administrator) [decided]
`GET /export/summary?p=…&from=…&to=…&format=csv|json` — per project: name, start, deadline, estimate, FTE-days logged in range, touched days in range, first/last entry date. **No notes.** Default range: all time. [my call]

### Project diary `.log` [decided format, details my call]
Plain text, oldest first, stable fixed columns so it's both skimmable and parseable:

```
# Project: Glow
# Dates: 2026-03-02 → 2027-02-26
# Estimate: 40 FTE-days | Logged: 31.5 FTE-days | Touched days: 6
# Exported: 2026-11-05

2026-11-04  touch     [agent:claude-code]
  - Reviewed SAML options

2026-11-05  0.10 FTE  [web]
  Answered emails on data integrity and security model.
```

- Line 1 of each entry: `YYYY-MM-DD`, two spaces, FTE padded to `0.00 FTE` or `touch    `, two spaces, `[source]`. Notes indented two spaces. Blank line between entries.
- Purpose: hand to a manager, feed to an AI for a summary, possible future research on how RSE projects evolve, personal skimming. [decided]

### Project diary `.json` [decided]
Same data: `{project, exported_at, totals, entries: Entry[]}`.

## 13. Testing [my call]
- Unit: totals (FTE sum, touch counting, before/after bins, span calc for missing start/deadline), `.log` formatting, name resolution, PAT hashing/lookup, ETag retry loop (mocked S3 returning 412).
- One integration smoke test against a real dev bucket (optional, manual).
- No-JS check: pages render with a plain `fetch` + HTML assertions (forms present, no script-dependent content).

## 14. Left to the builder
- Project layout, router/templating approach, test framework.
- Exact cookie/session mechanics within the constraints above.
- Exact palette and CSS beyond the decided look.
- Terraform module structure within the two-state split.
- Timezone handling: entries carry a user-local `date`; "today" for the API defaults to Europe/London unless the client sends `date`. [my call, adjustable per user setting later]

## 15. Builder-check resolutions [my call]

- **Stable URL / stack split.** Supersedes the two-state split in §6: one Terraform root (`infra/`) with `lifecycle { prevent_destroy = true }` on the data bucket and Cognito user pool. "Redeploy" = `terraform apply` with new Lambda code / assets; the CloudFront distribution is never recreated, so its domain, the Cognito callback URLs and agents' `RSE_DIARY_URL` stay stable. Optional `domain_name` + `acm_certificate_arn` variables for a custom domain later.
- **Account / deploy.** Deploys run from a laptop with `terraform apply`; local state by default, with a commented S3 backend block to fill in. Tags via a `tags` variable. If the org bans Lambda function URLs, swap for an API Gateway HTTP API (only the CloudFront origin changes).
- **Totals definitions** (used everywhere, including summary export):
  - *FTE-days* = sum of `fte` over non-touch entries.
  - *Days worked* on a project = distinct dates with any entry (FTE or touch) for it. A calendar dot appears on these days.
  - *Touch-only days* = days worked where every entry for that project is a touch. This is the "touched days" figure shown in the UI and exports.
  - Day totals (calendar shade, >1.0 warning) include Overheads.
  - The summary export lists Overheads as its own row.
- **Duplicate projects.** Names are matched on a normalised key: lowercase, strip everything except letters and digits. "RSE diary", "rse-diary" and "RSE Diary" collide; "RSE Diary project" does not. Creating a project whose key matches an existing one (via `POST /api/projects` or `create_project: true`) never duplicates. It returns the existing project, with a `note` saying so. A 422 for an unknown name lists up to 5 closest names (substring / edit-distance).
- **Entry writes across months.** All items are validated first; projects are created before entries; entries are grouped per month file. Optional `client_id` on an entry makes retries idempotent (same `client_id` + date = update, not duplicate).
