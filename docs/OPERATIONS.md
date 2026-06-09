# Operations Guide

## Run Locally

```bash
npm start
```

Open `http://127.0.0.1:4174` if you use `PORT=4174`.

## Run One Crawl

With the server already running:

```bash
npm run pipeline:run
```

This calls `/api/pipeline/run`, refreshes the latest jobs, enriches emails, runs analysis, and updates `data/store.json`.

To backfill more LLM reviews in one run, raise the per-run limit:

```bash
PIPELINE_LLM_LIMIT=200 npm run pipeline:run
```

The daily and monthly cost caps still apply. Existing jobs with a matching saved LLM review are reused and are not charged again.

## Daily Automation Options

### Cron

Example daily run at 09:00 Hong Kong time:

```cron
0 9 * * * cd /Users/tiksir/git/freehunter-ai && DASHBOARD_URL=http://127.0.0.1:4174 npm run pipeline:run >> data/pipeline.log 2>&1
```

### Hermes Agent

Ask Hermes to run:

```bash
cd /Users/tiksir/git/freehunter-ai
npm run pipeline:run
```

Then ask it to summarize:

- new `shortlisted` jobs
- `needs_info` jobs requiring client clarification
- approved drafts waiting for manual sending
- cost-cap or provider errors

Hermes should not send outreach unless you explicitly approve a specific message and destination.

## Human Daily Routine

1. Open dashboard.
2. Filter `AI Fit = 容易`.
3. Check `Approval Queue`.
4. Read job detail and client notes.
5. Edit the email draft if needed.
6. Click `Approve draft` only when the wording and quote stance are acceptable.
7. Copy draft manually into your email client.
8. After you send manually, set pipeline status to `sent`.
9. When the client replies, update status to `replied`, `won`, `lost`, or `archived`.

## Project Workspaces

Use `Create project` on a job detail page to create a local workspace under `projects/`.

Each workspace contains:

- `brief.md` — job brief, client details, AI analysis, and manager notes
- `conversation.md` — pasted client conversation
- `tasks.md` — task checklist for worker agents
- `worker-prompt.md` — prompt to hand to Codex, Hermes, or another worker
- `questions.md` — worker questions for Jack/client
- `progress.md` — worker progress log
- `handoff.md` — final worker notes back to Hermes/Jack
- `manager-flow.md` — fixed manager/worker operating flow
- `source/` — code/design source files
- `deliverables/` — local folder for generated files and export notes

These files are local only. Creating or syncing a project does not contact the client.

## Hermes Handoff Button

Use `Pass to Hermes Agent` when a job is ready for manager handling.

The button does three things:

1. Creates or syncs the project workspace under `projects/`.
2. Writes a handoff bundle under `data/hermes-outbox/<job-id-title>/`.
3. If configured, POSTs the same handoff JSON to `HERMES_AGENT_WEBHOOK_URL`.

Default local-only mode:

```bash
HERMES_HANDOFF_MODE=file
HERMES_OUTBOX_DIR=./data/hermes-outbox
```

Webhook mode when the Hermes portal is ready:

```bash
HERMES_HANDOFF_MODE=both
HERMES_AGENT_WEBHOOK_URL=http://your-hermes-machine-or-portal/handoff
HERMES_AGENT_TOKEN=replace-with-shared-secret
```

The handoff bundle contains `handoff.json`, `handoff.md`, and `worker-prompt.md`. Hermes should read the bundle, consolidate any missing questions, pass implementation work to Codex when needed, and write all external/internal communication back to the dashboard timeline.

## Cancelling a Hermes Handoff

If Jack decides a passed job is not worth pursuing, use `Cancel Hermes` on the job detail page.

Cancellation does not delete files. It:

1. Sets the opportunity pipeline status to `archived`.
2. Sets the project status to `paused`.
3. Marks the Hermes handoff as `cancelled`.
4. Writes `cancelled.json`, `cancelled.md`, and `STATUS.cancelled.txt` into the outbox folder.
5. Adds an internal timeline event.

Hermes should treat any `cancelled.json` or `STATUS.cancelled.txt` as a stop signal and should not continue drafting, assigning workers, sending messages, or delivering files for that opportunity.

## Recommended Machine Layout

For experiments, keeping everything on this work machine is fine. For always-on operations, move the runtime to the Hermes machine:

```text
Hermes machine:
  freehunter-ai dashboard server
  data/store.json
  data/hermes-outbox/
  projects/
  Hermes Agent portal
  email inbox adapter
  daily pipeline schedule

Work machine:
  Codex development sessions
  heavier project implementation
```

If you want one source of truth, the Hermes machine should own `data/` and `projects/`. Codex can still work on a copied/synced project folder, but the final `progress.md`, `questions.md`, `handoff.md`, and deliverables should be synced back to the Hermes machine.

Migration checklist:

1. Copy this repository to the Hermes machine.
2. Copy `.env`, `data/store.json`, `data/hermes-outbox/`, and `projects/`.
3. Run `npm start` on the Hermes machine.
4. Update `DASHBOARD_URL` to the Hermes machine URL.
5. Point Hermes Agent at `HERMES_OUTBOX_DIR` or set `HERMES_AGENT_WEBHOOK_URL`.
6. Keep email sending disabled until outbound logging and approval gates are verified.

## Manual Checklist Before Sending

- Email address is correct.
- Client/company identity makes sense.
- You are comfortable with the job scope.
- Draft does not mention AI unless strategically intended.
- Price and delivery date are not overpromised.
- Sensitive or regulated work has human review.

## Provider Setup

### Rule mode

No keys needed:

```bash
LLM_ANALYSIS_PROVIDER=rule
LLM_ENABLE_NETWORK_ANALYSIS=0
```

### Mock mode

Tests premium-review plumbing without spending money:

```bash
LLM_ANALYSIS_PROVIDER=mock
LLM_ENABLE_NETWORK_ANALYSIS=0
```

### OpenRouter

```bash
LLM_ANALYSIS_PROVIDER=openrouter
LLM_ENABLE_NETWORK_ANALYSIS=1
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_ANALYSIS_MODEL=deepseek/deepseek-v4-flash
LLM_INPUT_USD_PER_1M=0.0983
LLM_OUTPUT_USD_PER_1M=0.1966
LLM_JSON_RETRY_ON_PARSE_ERROR=1
LLM_REQUEST_TIMEOUT_MS=60000
LLM_DAILY_USD_CAP=3
LLM_MONTHLY_USD_CAP=50
LLM_CONCURRENCY=3
```

The default broad-review model is fixed to `deepseek/deepseek-v4-flash` so all jobs are scored with one consistent standard instead of `openrouter/auto` picking different models. If a specific model returns `403 Forbidden` through OpenRouter, choose another model available to your OpenRouter account and update the pricing overrides. The dashboard shows whether a job score came from a paid LLM review, a local rule score, or an LLM error fallback.

Before sending a job to OpenRouter/OpenAI, the server redacts contact details from the prompt: client email/name is not sent, and emails, Hong Kong phone numbers, and URLs inside the job text are replaced with placeholders. Client contact data stays in the local dashboard/store for outreach only.

### OpenAI Direct

```bash
LLM_ANALYSIS_PROVIDER=openai
LLM_ENABLE_NETWORK_ANALYSIS=1
OPENAI_API_KEY=sk-...
OPENAI_ANALYSIS_MODEL=gpt-5-mini
LLM_DAILY_USD_CAP=3
LLM_MONTHLY_USD_CAP=50
```

## Cost Controls

Start low:

```bash
LLM_TRIAGE_MAX_JOBS=10
LLM_CONCURRENCY=1
LLM_PREMIUM_SCORE_MIN=80
LLM_DAILY_USD_CAP=1
LLM_MONTHLY_USD_CAP=20
LLM_REVIEW_MODE=analysis_only
LLM_REVIEW_ALL_NEW_JOBS=1
LLM_JSON_RETRY_ON_PARSE_ERROR=1
```

Only raise limits after reviewing `data/store.json` and dashboard output for a few days.

Use `LLM_REVIEW_MODE=analysis_only` for the daily crawl. It lets the paid model refine score, fit, risks, and next step, while keeping the local rule-based email draft as a cheap placeholder.

Use `LLM_REVIEW_MODE=analysis_and_draft` only when you deliberately want the paid model to also rewrite outreach drafts for the selected high-score jobs.

Daily crawls are incremental. The server still reads the latest Freehunter rows, but it stores each job's AI review with a content signature. If a job already has a matching OpenRouter/OpenAI review, the dashboard reuses that score and does not call the paid model again. New jobs, changed jobs, or jobs reviewed with a different model/review mode enter the LLM queue.

Keep `LLM_REVIEW_ALL_NEW_JOBS=1` if every new job should receive an OpenRouter/OpenAI score. Set it to `0` to only review jobs whose local rule score is at least `LLM_PREMIUM_SCORE_MIN`.

## No-Side-Effect Guarantee

Current MVP does not contain any SMTP, Gmail, Resend, or Freehunter application submitter. `Approve draft` only writes local JSON.
