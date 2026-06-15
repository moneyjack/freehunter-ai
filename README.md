# Freehunter AI Job Dashboard

Local dashboard for collecting Freehunter job posts and matching each job with the client email returned by `getClientEmail`.

## Run

```bash
npm start
```

Open:

```text
http://localhost:4173
```

If port `4173` is already in use:

```bash
PORT=4174 npm start
```

Copy the environment template when you are ready to connect providers:

```bash
cp .env.example .env
```

## API Flow

1. `GET https://freehunter.hk/apis/jobs/getAllJobs`
2. For each unique `user_id`, `POST https://freehunter.hk/apis/jobs/getClientEmail` with `{ "id": user_id }`
3. The local server filters to the latest 30 days by default
4. Recent jobs are enriched with email and AI opportunity analysis
5. The local workflow state is merged from `data/store.json`
6. Results are returned at `/api/jobs`

The local server still reads the full Freehunter API response, but it only enriches recent rows with emails by default. Client emails are cached for 60 minutes.

Opening the dashboard uses `llmLimit=0`, so it reuses saved LLM scores and does not spend model credits. Click `Refresh + score` or run `npm run pipeline:run` when you deliberately want to fetch latest jobs and score new/changed rows.

To fetch all historical rows:

```text
/api/jobs?days=all
```

## AI Triage

Each recent job gets an `aiAnalysis` object with:

- `status`: `easy`, `needs_info`, `hard`, or `not_fit`
- `score`: 0-100
- `summary`: short internal reason
- `aiCanDo`: what can be accelerated
- `humanNeeds`: what still needs human approval or delivery
- `missingInfo`: what to ask the client
- `risks`: why the job may be awkward or expensive
- `quoteRecommendation`: whether to quote now, suggested HKD range, assumptions, and quote line
- `executionPlan`: concrete delivery steps to make the outreach sound professional
- `emailDraft`: a simple Cantonese outreach or clarification draft

Email drafts are generated for review and copying only. The app does not send email automatically.

## Approval Queue

Each job has a local `workflow` object:

- `pipelineStatus`: `new`, `shortlisted`, `needs_info`, `drafted`, `approved`, `sent`, `replied`, `won`, `lost`, or `archived`
- `draft`: editable outreach draft
- `notes`: internal human notes
- `manualPrice`: quote or pricing note

The dashboard lets you save status, edit drafts, copy drafts, and approve drafts. These actions only update local JSON. They do not send email.

## Agent Manager Flow

The intended operating model is:

1. Dashboard imports jobs, scores them, and stores the local CRM state.
2. You approve outreach or clarification drafts.
3. Hermes Agent manages inbox follow-up, status updates, and question consolidation.
4. When a job is ready to execute, click `Create project` or `Pass to Hermes Agent`.
5. The app creates a workspace under `projects/` and a Hermes handoff bundle under `data/hermes-outbox/`.
6. Hermes can pass `worker-prompt.md` to Codex for implementation work.
7. Codex works inside the project folder and writes questions/progress/handoff notes.
8. Hermes drafts the next client reply and logs every email/WhatsApp/Freehunter message back into the dashboard.
9. You approve external sends, quotes, money commitments, and final deliverables.

Project workspaces contain:

- `brief.md`
- `conversation.md`
- `tasks.md`
- `worker-prompt.md`
- `questions.md`
- `progress.md`
- `handoff.md`
- `manager-flow.md`
- `source/`
- `deliverables/`

Hermes handoff can run in file, webhook, or both modes:

```bash
HERMES_HANDOFF_MODE=file
HERMES_OUTBOX_DIR=./data/hermes-outbox
HERMES_AGENT_WEBHOOK_URL=
HERMES_AGENT_TOKEN=
```

## Run One Pipeline Crawl

Start the server first, then:

```bash
npm run pipeline:run
```

This is the command to schedule with cron or ask Hermes Agent to run.

## Deploy To Vercel

This app can run on Vercel as a static dashboard plus one serverless API function.

Vercel deploy files:

- `vercel.json`
- `api/index.js`
- `public/`
- `server.js`

Important: Vercel serverless file writes are not durable. If `STORE_PROVIDER=file`, the app uses `/tmp` on Vercel and may lose workflow state after cold starts. Use Supabase for a real deployed dashboard.

### Persistent Store With Supabase

Create this table in Supabase:

```sql
create table if not exists public.freehunter_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
```

Set these Vercel environment variables:

```bash
STORE_PROVIDER=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORE_TABLE=freehunter_state
SUPABASE_STORE_KEY=store
```

Also set the LLM provider variables if you want `Refresh + score` to run paid AI analysis on Vercel:

```bash
LLM_ANALYSIS_PROVIDER=openrouter
LLM_ENABLE_NETWORK_ANALYSIS=1
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_ANALYSIS_MODEL=deepseek/deepseek-v4-flash
LLM_INPUT_USD_PER_1M=0.0983
LLM_OUTPUT_USD_PER_1M=0.1966
LLM_DAILY_USD_CAP=3
LLM_MONTHLY_USD_CAP=50
```

Without `OPENROUTER_API_KEY`, the deployed dashboard still fetches Freehunter jobs and emails, but uses local rule scoring only.

## LLM Provider Modes

Default is free local rule mode:

```bash
LLM_ANALYSIS_PROVIDER=rule
LLM_ENABLE_NETWORK_ANALYSIS=0
```

Use mock mode to test the premium-review plumbing without spending money:

```bash
LLM_ANALYSIS_PROVIDER=mock
```

Use OpenRouter or OpenAI only after adding keys and caps in `.env`:

```bash
LLM_ANALYSIS_PROVIDER=openrouter
LLM_ENABLE_NETWORK_ANALYSIS=1
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_ANALYSIS_MODEL=deepseek/deepseek-v4-flash
LLM_INPUT_USD_PER_1M=0.0983
LLM_OUTPUT_USD_PER_1M=0.1966
```

LLM review prompts redact contact data before leaving the local machine: client names/emails are not included, and emails, Hong Kong phone numbers, and URLs inside job text are replaced with placeholders.

```bash
LLM_ANALYSIS_PROVIDER=openai
LLM_ENABLE_NETWORK_ANALYSIS=1
OPENAI_API_KEY=sk-...
```

## Automation Guardrails

Before sending outreach automatically, keep these manual gates:

1. Human approves whether to contact the client.
2. Human approves final price and delivery date.
3. Human reviews the first email.
4. Human reviews final deliverables before sending to the client.

More detail:

- [Architecture](docs/ARCHITECTURE.md)
- [Operations Guide](docs/OPERATIONS.md)

## Useful Env Vars

```bash
PORT=4173
HOST=127.0.0.1
CACHE_TTL_MS=300000
EMAIL_CONCURRENCY=8
REQUEST_TIMEOUT_MS=20000
LLM_REQUEST_TIMEOUT_MS=60000
JOB_LOOKBACK_DAYS=30
DATA_DIR=./data
PROJECTS_DIR=./projects
STORE_PROVIDER=file
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORE_TABLE=freehunter_state
SUPABASE_STORE_KEY=store
HERMES_HANDOFF_MODE=file
HERMES_OUTBOX_DIR=./data/hermes-outbox
HERMES_AGENT_WEBHOOK_URL=
HERMES_AGENT_TOKEN=
HERMES_REQUEST_TIMEOUT_MS=20000
OUTREACH_OWNER_NAME=Jack Lo
OUTREACH_OWNER_PHONE=51129438
LLM_ANALYSIS_PROVIDER=rule
LLM_ENABLE_NETWORK_ANALYSIS=0
LLM_TRIAGE_MAX_JOBS=300
LLM_CONCURRENCY=3
LLM_PREMIUM_SCORE_MIN=72
LLM_DAILY_USD_CAP=3
LLM_MONTHLY_USD_CAP=50
LLM_REVIEW_MODE=analysis_only
LLM_REVIEW_ALL_NEW_JOBS=1
LLM_JSON_RETRY_ON_PARSE_ERROR=1
OPENROUTER_ANALYSIS_MODEL=deepseek/deepseek-v4-flash
LLM_INPUT_USD_PER_1M=0.0983
LLM_OUTPUT_USD_PER_1M=0.1966
```
