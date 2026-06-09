const dashboardUrl = process.env.DASHBOARD_URL || 'http://127.0.0.1:4174';
const days = process.env.PIPELINE_LOOKBACK_DAYS || process.env.JOB_LOOKBACK_DAYS || '30';
const llmLimit = process.env.PIPELINE_LLM_LIMIT || process.env.LLM_TRIAGE_MAX_JOBS || '25';

const response = await fetch(`${dashboardUrl.replace(/\/+$/, '')}/api/pipeline/run`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ days, llmLimit })
});

const payload = await response.json();

if (!response.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

const summary = {
  ok: true,
  fetchedAt: payload.meta?.fetchedAt,
  count: payload.meta?.count,
  sourceCount: payload.meta?.sourceCount,
  emailsFound: payload.meta?.emailsFound,
  ai: {
    easy: payload.meta?.aiEasy,
    needsInfo: payload.meta?.aiNeedsInfo,
    hard: payload.meta?.aiHard,
    notFit: payload.meta?.aiNotFit,
    averageScore: payload.meta?.averageAiScore
  },
  pipeline: payload.meta?.pipeline,
  llm: payload.meta?.llm
};

console.log(JSON.stringify(summary, null, 2));
