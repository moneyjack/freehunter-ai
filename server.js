import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnvFile(path.join(__dirname, '.env'));

const IS_VERCEL = process.env.VERCEL === '1';
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const API_BASE = process.env.FREEHUNTER_API_BASE || 'https://freehunter.hk/apis/jobs';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const EMAIL_CONCURRENCY = Number(process.env.EMAIL_CONCURRENCY || 8);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const LLM_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS || 60000);
const DEFAULT_LOOKBACK_DAYS = Number(process.env.JOB_LOOKBACK_DAYS || 30);
const DATA_DIR = process.env.DATA_DIR || (IS_VERCEL ? path.join('/tmp', 'freehunter-ai-data') : path.join(__dirname, 'data'));
const STORE_PATH = process.env.STORE_PATH || path.join(DATA_DIR, 'store.json');
const STORE_PROVIDER = (process.env.STORE_PROVIDER || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'file')).toLowerCase();
const SUPABASE_URL = trimTrailingSlash(process.env.SUPABASE_URL || '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORE_TABLE = process.env.SUPABASE_STORE_TABLE || 'freehunter_state';
const SUPABASE_STORE_KEY = process.env.SUPABASE_STORE_KEY || 'store';
const PROJECTS_DIR = process.env.PROJECTS_DIR || (IS_VERCEL ? path.join('/tmp', 'freehunter-ai-projects') : path.join(__dirname, 'projects'));
const HERMES_OUTBOX_DIR = process.env.HERMES_OUTBOX_DIR || path.join(DATA_DIR, 'hermes-outbox');
const HERMES_AGENT_WEBHOOK_URL = (process.env.HERMES_AGENT_WEBHOOK_URL || '').trim();
const HERMES_AGENT_TOKEN = process.env.HERMES_AGENT_TOKEN || '';
const HERMES_HANDOFF_MODE = normalizeHermesHandoffMode(
  process.env.HERMES_HANDOFF_MODE || (HERMES_AGENT_WEBHOOK_URL ? 'both' : 'file')
);
const HERMES_REQUEST_TIMEOUT_MS = Number(process.env.HERMES_REQUEST_TIMEOUT_MS || 20000);
const OUTREACH_OWNER_NAME = process.env.OUTREACH_OWNER_NAME || 'Jack Lo';
const OUTREACH_OWNER_PHONE = process.env.OUTREACH_OWNER_PHONE || '51129438';
const LLM_ANALYSIS_PROVIDER = (process.env.LLM_ANALYSIS_PROVIDER || 'rule').toLowerCase();
const LLM_ENABLE_NETWORK_ANALYSIS = process.env.LLM_ENABLE_NETWORK_ANALYSIS === '1';
const LLM_TRIAGE_MAX_JOBS = Number(process.env.LLM_TRIAGE_MAX_JOBS || 25);
const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 3);
const LLM_PREMIUM_SCORE_MIN = Number(process.env.LLM_PREMIUM_SCORE_MIN || 72);
const LLM_DAILY_USD_CAP = Number(process.env.LLM_DAILY_USD_CAP || 3);
const LLM_MONTHLY_USD_CAP = Number(process.env.LLM_MONTHLY_USD_CAP || 50);
const LLM_REVIEW_MODE = normalizeLlmReviewMode(process.env.LLM_REVIEW_MODE || 'analysis_only');
const LLM_REVIEW_ALL_NEW_JOBS = process.env.LLM_REVIEW_ALL_NEW_JOBS !== '0';
const LLM_REVIEW_SCHEMA_VERSION = 3;
const LLM_JSON_RETRY_ON_PARSE_ERROR = process.env.LLM_JSON_RETRY_ON_PARSE_ERROR !== '0';
const DEFAULT_OPENROUTER_ANALYSIS_MODEL = 'deepseek/deepseek-v4-flash';

const PIPELINE_STATUSES = new Set([
  'new',
  'shortlisted',
  'needs_info',
  'drafted',
  'approved',
  'sent',
  'replied',
  'won',
  'lost',
  'archived'
]);

const DRAFT_STATUSES = new Set(['generated', 'edited', 'approved', 'copied']);
const COMMUNICATION_CHANNELS = new Set(['email', 'whatsapp', 'freehunter', 'phone', 'agent_note', 'other']);
const COMMUNICATION_DIRECTIONS = new Set(['outbound', 'inbound', 'internal']);
const PROJECT_STATUSES = new Set([
  'not_started',
  'briefing',
  'waiting_client',
  'ready_for_worker',
  'in_progress',
  'needs_human',
  'ready_to_deliver',
  'delivered',
  'paused'
]);

const jobsCache = new Map();

const emailCache = new Map();

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
]);

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        cacheTtlMs: CACHE_TTL_MS,
        store: publicStoreConfig(),
        storePath: STORE_PATH,
        projectsDir: PROJECTS_DIR,
        hermes: publicHermesConfig(),
        llm: publicLlmConfig()
      });
    }

    if (url.pathname === '/api/jobs') {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const lookbackDays = parseLookbackDays(url.searchParams.get('days'));
      const llmLimit = parseLlmLimit(url.searchParams.get('llmLimit'));
      const payload = await getEnrichedJobs({ forceRefresh, lookbackDays, llmLimit });
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/store') {
      const store = await readStore();
      return sendJson(res, 200, summarizeStore(store));
    }

    if (url.pathname === '/api/pipeline/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const lookbackDays = parseLookbackDays(body.days);
      const llmLimit = parseLlmLimit(body.llmLimit);
      const payload = await getEnrichedJobs({ forceRefresh: true, lookbackDays, llmLimit });
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/job-state' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await updateOpportunityState(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/draft' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await updateDraft(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/draft/approve' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await approveDraft(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/draft/copy' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await recordDraftCopied(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/communication' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await recordCommunication(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/project' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await updateProject(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/hermes/handoff' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await handoffToHermes(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/hermes/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = await cancelHermesHandoff(body);
      jobsCache.clear();
      return sendJson(res, 200, payload);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, error.statusCode || 500, {
      error: 'Server error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

const server = http.createServer(handleRequest);

if (!IS_VERCEL) {
  listen(PORT);
}

export { handleRequest };
export default handleRequest;

async function getEnrichedJobs({ forceRefresh = false, lookbackDays = DEFAULT_LOOKBACK_DAYS, llmLimit = LLM_TRIAGE_MAX_JOBS } = {}) {
  const now = Date.now();
  const cacheKey = `${lookbackDays ? `days:${lookbackDays}` : 'all'}:llm:${llmLimit}`;
  const cached = jobsCache.get(cacheKey);
  const cacheFresh = cached?.data && now - cached.fetchedAt < CACHE_TTL_MS;

  if (!forceRefresh && cacheFresh) {
    return {
      ...cached.data,
      meta: {
        ...cached.data.meta,
        cached: true,
        servedAt: new Date().toISOString()
      }
    };
  }

  const rawJobs = await fetchAllJobs();
  const cutoffSeconds = lookbackDays ? Math.floor(now / 1000) - lookbackDays * 24 * 60 * 60 : 0;
  const recentRawJobs = cutoffSeconds
    ? rawJobs.filter((job) => getJobCreatedAtSeconds(job) >= cutoffSeconds)
    : rawJobs;
  const uniqueClientIds = [
    ...new Set(recentRawJobs.map((job) => job.user_id).filter((id) => id !== null && id !== undefined))
  ];

  const emailEntries = await mapLimit(uniqueClientIds, EMAIL_CONCURRENCY, async (clientId) => {
    const emailInfo = await fetchClientEmail(clientId);
    return [String(clientId), emailInfo];
  });

  const emailMap = new Map(emailEntries);
  const jobs = recentRawJobs
    .map((job) => normalizeJob(job, emailMap.get(String(job.user_id))))
    .sort((a, b) => b.createdAtSeconds - a.createdAtSeconds || b.id - a.id);

  const store = await readStore();
  const aiRestore = restoreStoredAiAnalysis(jobs, store);
  const llmRun = await maybeEnhanceJobsWithLlm(jobs, store, { llmLimit });
  const storeMerge = mergeJobsIntoStore(jobs, store);
  if (llmRun.changed || storeMerge.changed) {
    await writeStore(store);
  }

  const meta = {
    count: jobs.length,
    sourceCount: rawJobs.length,
    excludedOlderThanWindow: rawJobs.length - recentRawJobs.length,
    lookbackDays,
    includedSince: cutoffSeconds ? new Date(cutoffSeconds * 1000).toISOString() : null,
    uniqueClients: uniqueClientIds.length,
    emailsFound: jobs.filter((job) => Boolean(job.clientEmail)).length,
    emailErrors: jobs.filter((job) => job.emailStatus === 'error').length,
    aiEasy: jobs.filter((job) => job.aiAnalysis?.status === 'easy').length,
    aiNeedsInfo: jobs.filter((job) => job.aiAnalysis?.status === 'needs_info').length,
    aiHard: jobs.filter((job) => job.aiAnalysis?.status === 'hard').length,
    aiNotFit: jobs.filter((job) => job.aiAnalysis?.status === 'not_fit').length,
    averageAiScore: jobs.length
      ? Math.round(jobs.reduce((sum, job) => sum + (job.aiAnalysis?.score || 0), 0) / jobs.length)
      : 0,
    pipeline: buildPipelineSummary(jobs),
    llm: llmRun.summary,
    aiRestore,
    newestJobAt: jobs[0]?.createdAtIso || null,
    oldestIncludedJobAt: jobs.at(-1)?.createdAtIso || null,
    fetchedAt: new Date().toISOString(),
    servedAt: new Date().toISOString(),
    cached: false,
    cacheTtlMs: CACHE_TTL_MS
  };

  const data = { result: jobs, meta };
  jobsCache.set(cacheKey, { data, fetchedAt: now });
  return data;
}

async function fetchAllJobs() {
  const payload = await fetchJson(`${API_BASE}/getAllJobs`, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!payload || !Array.isArray(payload.result)) {
    throw new Error('Unexpected getAllJobs response shape');
  }

  return payload.result;
}

async function fetchClientEmail(clientId) {
  const cacheKey = String(clientId);
  const cached = emailCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS * 12) {
    return cached;
  }

  try {
    const payload = await fetchJson(`${API_BASE}/getClientEmail`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: Number(clientId) })
    });

    const email = typeof payload?.result === 'string' ? payload.result.trim() : '';
    const info = {
      email,
      error: email ? '' : 'No email returned',
      fetchedAt: Date.now()
    };
    emailCache.set(cacheKey, info);
    return info;
  } catch (error) {
    return {
      email: '',
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now()
    };
  }
}

async function fetchJson(url, options) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from ${url}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeJob(job, emailInfo = {}) {
  const createdAtSeconds = getJobCreatedAtSeconds(job);

  const latestModifySeconds = timestampSeconds(job.lastest_modify_time);
  const skills = Array.isArray(job.skill_list) ? job.skill_list.filter(Boolean) : [];
  const applications = Array.isArray(job.application) ? job.application.length : 0;
  const invitations = Array.isArray(job.invite_user_list) ? job.invite_user_list.length : 0;

  const normalized = {
    id: Number(job.id || 0),
    title: stringValue(job.title) || '(未命名工作)',
    detail: stringValue(job.detail),
    hideDetail: stringValue(job.hide_detail),
    clientId: job.user_id ?? null,
    clientName: stringValue(job.user_name),
    clientEmail: emailInfo.email || '',
    emailStatus: emailInfo.email ? 'ok' : emailInfo.error ? 'error' : 'missing',
    emailError: emailInfo.error || '',
    categoryId: job.category_id ?? null,
    categoryName: stringValue(job.category_name),
    catalogId: job.catalog_id ?? null,
    skills,
    budget: stringValue(job.budget),
    budgetType: stringValue(job.budget_type),
    status: stringValue(job.status),
    directApply: Boolean(job.direct_apply),
    duration: stringValue(job.duration),
    location: stringValue(job.location),
    region: job.region ?? null,
    district: job.district ?? null,
    posterLocation: stringValue(job.poster_location),
    createdAtText: stringValue(job.created_at),
    createdAtSeconds,
    createdAtIso: createdAtSeconds ? new Date(createdAtSeconds * 1000).toISOString() : null,
    latestModifySeconds,
    latestModifyIso: latestModifySeconds ? new Date(latestModifySeconds * 1000).toISOString() : null,
    boostStatus: Boolean(job.boost_status),
    applicationCount: applications,
    inviteCount: invitations,
    nature: stringValue(job.nature),
    raw: job
  };

  return {
    ...normalized,
    aiAnalysis: analyzeJob(normalized)
  };
}

function analyzeJob(job) {
  const text = normalizeText([
    job.title,
    job.detail,
    job.hideDetail,
    job.categoryName,
    job.budget,
    job.duration,
    job.location,
    job.posterLocation,
    ...(job.skills || [])
  ].join('\n'));

  const signals = [];
  const missingInfo = [];
  const risks = [];
  const aiCanDo = [];
  const humanNeeds = [
    '你最後決定接唔接同報價範圍',
    '首封 email 送出前由你過目',
    '付款、合約、交付承諾由你確認'
  ];

  let score = 34;
  let forcedStatus = '';

  if (job.status === 'approved') {
    score += 6;
    signals.push('項目已 approved，可以優先睇');
  }

  if (job.status === 'finished') {
    score -= 45;
    forcedStatus = 'not_fit';
    risks.push('項目狀態已 finished，通常唔值得再追');
  }

  if (job.status === 'pending') {
    score -= 12;
    risks.push('項目仍是 pending，未必可以即時接洽');
  }

  if (job.directApply) {
    score += 4;
    signals.push('可直接申請');
  }

  const matchedAreas = [];
  addAreaScore({
    area: 'development',
    label: '開發 / 網站 / App',
    keywords: ['網頁開發', '手機應用程式開發', '程式', '網站', 'web', 'app', 'api', 'ui設計', 'ux設計', 'figma', 'mvp'],
    points: 18,
    task: '整理需求、做 wireframe / prototype、寫網站或功能原型、協助部署'
  });
  addAreaScore({
    area: 'design',
    label: '設計 / 排版 / 插圖',
    keywords: ['logo', '海報', '傳單', '橫額', '排版', '卡片設計', '圖卡', '插圖', '數碼插畫', '產品包裝', '小冊子', 'banner', 'poster', 'canva', 'kv design'],
    points: 15,
    task: '出設計方向、初稿、不同尺寸版本、排版同輸出檔案'
  });
  addAreaScore({
    area: 'content',
    label: '內容 / SEO / 文案',
    keywords: ['seo', '內容', '文案', 'blog', '文章', '社交媒體', 'facebook', 'instagram', '小紅書', '電子報', '營銷', 'marketing', 'copywriting'],
    points: 17,
    task: '做資料整理、內容大綱、文案初稿、SEO 標題同社交媒體貼文'
  });
  addAreaScore({
    area: 'video',
    label: '影片 / 字幕 / 配音',
    keywords: ['影片剪接', '字幕', 'reels', 'shorts', '後期製作', '配音', '旁白', '混音', '音檔', 'voiceover'],
    points: 11,
    task: '做腳本整理、字幕、剪接方向、旁白稿、音量整理同交付格式規劃'
  });
  addAreaScore({
    area: 'ops',
    label: '營運 / 文書 / 客服',
    keywords: ['文員', '助理', '客服', '資料輸入', 'excel', 'powerpoint', '簡報', 'admin', 'remote assistant'],
    points: 9,
    task: '整理回覆模板、表格、流程文件、FAQ 同日常營運內容'
  });

  const physicalMatches = keywordMatches(text, [
    '到府',
    '上門',
    '回辦公室',
    '辦公室工作',
    '現場',
    '戶外',
    '主持',
    '司儀',
    '老師',
    '小提琴',
    'model',
    '模特',
    '直播',
    '出鏡',
    '拍攝',
    '只能使用我家的電腦',
    '全程喺旁邊'
  ]);

  if (physicalMatches.length) {
    score -= Math.min(40, 16 + physicalMatches.length * 5);
    risks.push(`需要真人/現場元素：${physicalMatches.slice(0, 4).join('、')}`);
    humanNeeds.push('如果仍想接，需要你本人或合作人處理現場/真人部分');
  }

  const vagueMatches = keywordMatches(text, ['可協商', '詳談', '所有job', '一切工作', '指定電郵', '報價', 'quote']);
  if (vagueMatches.length && job.detail.length < 280) {
    score -= 8;
    missingInfo.push('工作範圍同交付件未夠清楚');
  }

  if (job.detail.length < 90) {
    score -= 14;
    missingInfo.push('job brief 太短，要先問清楚要求');
  }

  if (!hasAny(text, ['初稿', '定稿', '交付', 'deadline', '完成', '工期', '時間', '日期'])) {
    missingInfo.push('未見清楚 deadline / 交付時間');
  }

  if (!hasAny(text, ['尺寸', '格式', '頁', '張', '條', '字', '功能', '範圍', 'scope', 'deliverable'])) {
    missingInfo.push('未見清楚數量、尺寸、格式或功能範圍');
  }

  if (hasAny(text, ['無限', 'unlimited', 'quick as possible', '即時', '急', '三日內', 'within_three_days'])) {
    score -= 9;
    risks.push('時間或改稿期望可能較急，要先界定範圍');
  }

  if (hasAny(text, ['醫學', '法律', '法例', '金融', '投資', '保險'])) {
    score -= 8;
    risks.push('涉及專業/合規內容，交付前要人手覆核');
    humanNeeds.push('專業準確性同風險位要你再檢查');
  }

  if (hasAny(text, ['長期合作', '每月', '長期'])) {
    score += 5;
    signals.push('有長期合作可能');
  }

  const budgetCeiling = budgetRank(job.budget);
  if (budgetCeiling >= 50000) {
    score += 10;
    signals.push('預算上限高，值得優先跟');
  } else if (budgetCeiling >= 10000) {
    score += 6;
    signals.push('預算合理');
  } else if (budgetCeiling && budgetCeiling <= 2000) {
    score -= 5;
    risks.push('預算偏細，要避免範圍失控');
  }

  if (hasAny(text, ['mvp', '15-20', '十三個網站', '13個網站', '平台', 'app']) && matchedAreas.includes('development')) {
    score -= 7;
    risks.push('開發範圍可能較大，要拆 MVP / phase 報價');
  }

  if (!aiCanDo.length) {
    score -= 18;
    aiCanDo.push('暫時只能協助整理需求、寫查詢 email 同做基本資料分析');
  }

  score = clamp(score, 0, 100);

  const status = chooseAiStatus({ score, forcedStatus, missingInfo, risks, physicalMatches, matchedAreas });
  const nextStep = chooseNextStep(status);
  const summary = buildAnalysisSummary(status, matchedAreas, missingInfo, risks);
  const pricingHint = buildPricingHint(job, status, matchedAreas);
  const quoteRecommendation = buildQuoteRecommendation(job, status, matchedAreas, missingInfo, risks);
  const executionPlan = buildExecutionPlan(job, matchedAreas, status);
  const emailDraft = buildEmailDraft(job, {
    status,
    missingInfo,
    aiCanDo,
    pricingHint,
    nextStep,
    quoteRecommendation,
    executionPlan
  });

  return {
    status,
    score,
    confidence: score >= 75 || score <= 25 ? 'high' : 'medium',
    summary,
    signals,
    aiCanDo: unique(aiCanDo),
    humanNeeds: unique(humanNeeds),
    missingInfo: unique(missingInfo),
    risks: unique(risks),
    recommendedNextStep: nextStep,
    pricingHint,
    quoteRecommendation,
    executionPlan,
    emailDraft
  };

  function addAreaScore({ area, label, keywords, points, task }) {
    const matches = keywordMatches(text, keywords);
    if (!matches.length) return;

    matchedAreas.push(area);
    score += points;
    signals.push(`${label} 有明顯 AI 槓桿：${matches.slice(0, 4).join('、')}`);
    aiCanDo.push(task);
  }
}

function chooseAiStatus({ score, forcedStatus, missingInfo, risks, physicalMatches, matchedAreas }) {
  if (forcedStatus) return forcedStatus;
  if (physicalMatches.length >= 2 && score < 45) return 'not_fit';
  if (!matchedAreas.length && score < 45) return 'not_fit';
  if (missingInfo.length >= 2 && score >= 45) return 'needs_info';
  if (score >= 72 && missingInfo.length <= 1) return 'easy';
  if (score >= 55 && risks.length <= 2) return missingInfo.length ? 'needs_info' : 'easy';
  if (score >= 38) return 'hard';
  return 'not_fit';
}

function chooseNextStep(status) {
  if (status === 'easy') return 'draft_apply_email';
  if (status === 'needs_info') return 'ask_for_details';
  if (status === 'hard') return 'manual_review';
  return 'skip';
}

function buildAnalysisSummary(status, matchedAreas, missingInfo, risks) {
  const areaText = matchedAreas.length ? matchedAreas.map(areaLabel).join('、') : '未見明確可交付範圍';

  if (status === 'easy') {
    return `幾適合用 AI 加人手覆核處理，主要係 ${areaText}。可以先接觸客戶，問齊素材同交付格式後報價。`;
  }

  if (status === 'needs_info') {
    return `有機會做，但資料未夠。先問清楚 ${missingInfo.slice(0, 2).join('、') || '工作範圍'}，再決定報價。`;
  }

  if (status === 'hard') {
    return `可以研究，但風險較高。${risks.slice(0, 2).join('；') || '範圍或時間要再拆細'}。建議人手先睇過。`;
  }

  return `暫時唔建議優先接。${risks.slice(0, 2).join('；') || 'AI 可槓桿位唔明顯，或者需要真人/現場交付'}。`;
}

function buildPricingHint(job, status, matchedAreas) {
  const ceiling = budgetRank(job.budget);
  const areaText = matchedAreas.map(areaLabel).join('、') || '項目';

  if (status === 'not_fit') return '唔建議直接報價。';
  if (status === 'hard') return `先拆 phase 報價，避免一次包晒成個 ${areaText}。`;
  if (!ceiling) return '先問清楚範圍，再報 fixed price 或按階段報價。';
  if (ceiling <= 2000) return '預算偏細，只適合報清楚有限範圍，例如一版初稿或一次修改。';
  if (ceiling <= 5000) return '可報一個細 scope fixed price，清楚列明交付件同修改次數。';
  if (ceiling <= 10000) return '可報 basic / standard 兩個方案，等客戶揀範圍。';
  return '值得先問資料，再用分階段報價：初稿、修改、最終輸出分開寫清楚。';
}

function buildQuoteRecommendation(job, status, matchedAreas, missingInfo, risks) {
  const budget = inferBudgetRange(job.budget);
  const area = matchedAreas[0] || 'general';
  const base = defaultQuoteForArea(area);
  const low = budget.max ? Math.max(base.low, Math.round(budget.max * 0.28 / 100) * 100) : base.low;
  const high = budget.max ? Math.min(Math.max(base.high, Math.round(budget.max * 0.55 / 100) * 100), budget.max) : base.high;
  const normalizedLow = Math.min(low, high || low);
  const normalizedHigh = Math.max(high || base.high, normalizedLow);
  const hasEnoughScope = status === 'easy' && missingInfo.length === 0 && risks.length <= 1;
  const canQuote = hasEnoughScope && normalizedHigh > 0;
  const range = formatHkdRange(normalizedLow, normalizedHigh);

  return {
    canQuote,
    range,
    low: normalizedLow,
    high: normalizedHigh,
    currency: 'HKD',
    confidence: canQuote ? 'medium' : 'low',
    basis: canQuote
      ? '根據 job brief、預算範圍、交付件同常見 freelance scope 估算，已預留少量議價空間。'
      : '資料未夠完整，暫時只適合講初步方向，正式報價前要先問清楚 scope。',
    assumptions: buildQuoteAssumptions(job, area),
    quoteLine: canQuote
      ? `我初步會建議以 ${range} 作為項目報價，實際金額可按最終 scope、修改次數同交付格式微調。`
      : `初步睇可以先以 ${range} 作為粗略參考，但我會先問清楚 scope，避免報價同實際需要有落差。`
  };
}

function buildExecutionPlan(job, matchedAreas, status) {
  const area = matchedAreas[0] || 'general';
  const common = [
    '先確認 scope、素材、交付格式同時間表',
    '整理需求後提交第一版方向或初稿',
    '按客戶回饋修改，最後整理可交付檔案',
    '交付前由人手覆核內容、格式同承諾範圍'
  ];
  const plans = {
    development: [
      '先整理功能清單、頁面結構同必要流程',
      '建立可瀏覽嘅第一版 prototype / MVP',
      '加入內容、基本 responsive layout 同必要互動',
      '測試主要流程後交付連結、原始碼或部署版本'
    ],
    design: [
      '先確認品牌素材、尺寸、文字內容同參考風格',
      '提供 1-2 個視覺方向作初步選擇',
      '確認方向後完成主要設計同排版',
      '按約定修改次數調整，最後輸出印刷/網用檔案'
    ],
    content: [
      '先確認目標受眾、語氣、平台同內容目的',
      '整理內容架構、標題方向同第一版文案',
      '按客戶回饋調整語氣、長度同 CTA',
      '最後交付可直接使用嘅文案/內容表'
    ],
    video: [
      '先確認原片、腳本、參考風格、比例同輸出格式',
      '整理剪接/配音/字幕方向同第一版 sample',
      '按回饋調整節奏、字幕、聲音同輸出格式',
      '最後交付約定格式嘅影片/音檔/字幕檔'
    ],
    ops: [
      '先確認工作流程、資料來源同輸出格式',
      '整理模板、表格或流程文件第一版',
      '按實際使用場景調整欄位、格式同語氣',
      '最後交付可重用嘅文件/模板/操作說明'
    ]
  };
  const selected = plans[area] || common;
  return status === 'hard'
    ? ['先拆細成第一階段，避免一次包晒過大 scope', ...selected.slice(0, 3)]
    : selected;
}

function inferBudgetRange(budget) {
  const numbers = String(budget || '')
    .replace(/,/g, '')
    .match(/\d+/g)
    ?.map(Number)
    .filter((number) => Number.isFinite(number) && number > 0) || [];
  return {
    min: numbers.length ? Math.min(...numbers) : 0,
    max: numbers.length ? Math.max(...numbers) : 0
  };
}

function defaultQuoteForArea(area) {
  const ranges = {
    development: { low: 6000, high: 18000 },
    design: { low: 2500, high: 9000 },
    content: { low: 1800, high: 6500 },
    video: { low: 2500, high: 9000 },
    ops: { low: 1500, high: 5000 },
    general: { low: 2500, high: 8000 }
  };
  return ranges[area] || ranges.general;
}

function buildQuoteAssumptions(job, area) {
  const common = ['包括一次初稿及合理修改', '不包括未列明嘅額外頁面、額外尺寸或大幅改方向'];
  if (area === 'development') return ['第一版以核心功能/MVP 為主', '不包括複雜會員系統、付款或大型後台，除非另行確認', ...common];
  if (area === 'design') return ['客戶提供文字內容、logo/品牌素材及尺寸要求', '包括網用或印刷用輸出格式，實際格式先確認', ...common];
  if (area === 'content') return ['客戶提供品牌資料、目標受眾及平台方向', '包括內容整理及文案修改，不包括大量訪問或深度研究', ...common];
  if (area === 'video') return ['客戶提供原片/文字稿/參考風格', '包括基本剪接、字幕或聲音整理，複雜動畫另議', ...common];
  return common;
}

function formatHkdRange(low, high) {
  const formatter = new Intl.NumberFormat('en-US');
  if (!high || low === high) return `HKD ${formatter.format(low)}`;
  return `HKD ${formatter.format(low)}-${formatter.format(high)}`;
}

function buildEmailDraft(job, analysis) {
  if (analysis.status === 'not_fit') {
    return {
      type: 'skip',
      subject: '',
      body: ''
    };
  }

  const clientName = cleanupName(job.clientName);
  const greeting = clientName ? `${clientName} 你好，` : '你好，';
  const deliverable = summarizeDeliverable(analysis.aiCanDo, job);
  const questions = buildEmailQuestions(analysis.missingInfo, job);
  const quote = analysis.quoteRecommendation || {};
  const executionPlan = Array.isArray(analysis.executionPlan) ? analysis.executionPlan : [];
  const subjectPrefix = analysis.status === 'easy' ? '關於' : '想了解多少少';
  const subject = `${subjectPrefix}「${job.title}」嘅合作`;
  const canQuote = Boolean(quote.canQuote);
  const quoteBlock = canQuote
    ? [
        `按目前資料，我初步報價會建議 ${quote.range}。呢個報價已預留少量調整空間，實際金額可以因應最終交付格式、修改次數同時間表再微調。`,
        '',
        '大概做法會係：',
        ...executionPlan.slice(0, 4).map((step, index) => `${index + 1}. ${step}`),
        '',
        '如果方向合適，我可以再按你哋提供嘅素材同 final scope，整理一個更正式嘅報價同交付時間。'
      ]
    : [
        quote.quoteLine || '我可以協助處理呢個項目，不過想先問清楚範圍，避免報價同實際需要有落差。',
        '',
        '想先確認幾點，方便我俾到準確報價同時間：',
        ...questions.map((question, index) => `${index + 1}. ${question}`),
        '',
        '資料齊之後，我可以再整理一個清楚報價、做法同預計交付時間俾你哋。'
      ];

  return {
    type: canQuote ? 'apply' : 'clarify',
    subject,
    body: [
      greeting,
      '',
      `我見到你哋喺 Freehunter 發佈「${job.title}」，我對呢個項目有興趣。睇完內容後，我初步可以協助${deliverable}。`,
      '',
      ...quoteBlock,
      '',
      '謝謝，',
      OUTREACH_OWNER_NAME,
      OUTREACH_OWNER_PHONE
    ].join('\n')
  };
}

function buildEmailQuestions(missingInfo, job) {
  const questions = [];

  if (missingInfo.some((item) => item.includes('範圍') || item.includes('數量') || item.includes('尺寸') || item.includes('格式'))) {
    questions.push('今次最終需要交付咩檔案/格式？數量同尺寸大概係點？');
  }

  if (missingInfo.some((item) => item.includes('deadline') || item.includes('時間'))) {
    questions.push('你哋期望初稿同 final 版本分別幾時完成？');
  }

  if (job.categoryName.includes('平面') || hasAny(normalizeText(job.skills.join(' ')), ['設計', '插圖', '排版', 'logo'])) {
    questions.push('有冇品牌 guideline、參考風格、文字內容或現有素材可以先睇？');
  } else if (job.categoryName.includes('程式') || hasAny(normalizeText(job.skills.join(' ')), ['網頁', 'app', 'ui', 'ux'])) {
    questions.push('有冇現有網站/設計稿/功能清單？邊啲功能係第一版一定要有？');
  } else if (job.categoryName.includes('營銷') || hasAny(normalizeText(job.skills.join(' ')), ['seo', '內容', '社交'])) {
    questions.push('目標客群、語氣風格同需要管理嘅平台係邊幾個？');
  } else if (job.categoryName.includes('影片') || hasAny(normalizeText(job.skills.join(' ')), ['影片', '字幕', '配音'])) {
    questions.push('原片/文字稿/參考影片有冇？需要輸出咩比例同格式？');
  }

  questions.push('預算係想按整個項目計，定係可以按階段/每件交付計？');
  return unique(questions).slice(0, 4);
}

function summarizeDeliverable(aiCanDo, job) {
  const text = normalizeText([job.title, job.categoryName, ...(job.skills || [])].join(' '));
  const list = Array.isArray(aiCanDo) ? aiCanDo : [];
  let first = '';

  if (hasAny(text, ['影片', '字幕', '配音', '旁白', 'reels', 'shorts'])) {
    first = list.find((item) => item.includes('腳本整理') || item.includes('字幕') || item.includes('旁白稿')) || '';
  }

  if (!first && hasAny(text, ['網頁', '程式', 'app', 'ui', 'ux', '網站'])) {
    first = list.find((item) => item.includes('wireframe') || item.includes('網站') || item.includes('功能原型')) || '';
  }

  if (!first && hasAny(text, ['seo', '內容', '文案', '社交', '營銷', 'blog'])) {
    first = list.find((item) => item.includes('內容大綱') || item.includes('文案')) || '';
  }

  if (!first && hasAny(text, ['設計', '插圖', 'logo', '海報', '圖卡', '排版', '包裝'])) {
    first = list.find((item) => item.includes('設計方向') || item.includes('排版')) || '';
  }

  first = first || list[0] || '整理需求、做初稿同按你哋回饋修改';
  return first
    .replace(/^做/, '做')
    .replace(/、協助部署$/, '同基本部署')
    .replace(/同交付格式規劃$/, '同輸出安排');
}

function cleanupName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed.length > 28) return '';
  return trimmed;
}

function areaLabel(area) {
  const labels = {
    development: '開發/網站',
    design: '設計',
    content: '內容/營銷',
    video: '影片/聲音',
    ops: '營運/文書'
  };
  return labels[area] || area;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function hasAny(text, keywords) {
  return keywordMatches(text, keywords).length > 0;
}

function keywordMatches(text, keywords) {
  return keywords.filter((keyword) => text.includes(String(keyword).toLowerCase()));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getJobCreatedAtSeconds(job) {
  return (
    timestampSeconds(job.created_at_datetime) ||
    timestampSeconds(job.createdAt) ||
    Number(job.timestamp_number || job.timestampNumber || 0) ||
    timestampSeconds(job.lastest_modify_time)
  );
}

function parseLookbackDays(value) {
  if (value === 'all') return 0;
  const parsed = Number(value || DEFAULT_LOOKBACK_DAYS);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LOOKBACK_DAYS;
  return Math.floor(parsed);
}

function parseLlmLimit(value) {
  if (value === null || value === undefined || value === '') return LLM_TRIAGE_MAX_JOBS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return LLM_TRIAGE_MAX_JOBS;
  return Math.floor(parsed);
}

function timestampSeconds(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object' && Number.isFinite(Number(value._seconds))) {
    return Number(value._seconds);
  }
  return 0;
}

function stringValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function budgetRank(budget) {
  const numbers = String(budget || '')
    .replace(/,/g, '')
    .match(/\d+/g)
    ?.map(Number);
  return numbers?.length ? Math.max(...numbers) : 0;
}

async function readJsonBody(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method || '')) return {};

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

async function readStore() {
  if (STORE_PROVIDER === 'supabase') {
    return readSupabaseStore();
  }

  try {
    const text = await readFile(STORE_PATH, 'utf8');
    const store = JSON.parse(text);
    return normalizeStore(store);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Unable to read store. Starting with empty store: ${error.message}`);
    }
    return normalizeStore({});
  }
}

async function writeStore(store) {
  const normalized = normalizeStore(store);
  normalized.updatedAt = new Date().toISOString();
  if (STORE_PROVIDER === 'supabase') {
    await writeSupabaseStore(normalized);
    return;
  }

  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

async function readSupabaseStore() {
  assertSupabaseStoreConfigured();
  const endpoint = `${SUPABASE_URL}/rest/v1/${SUPABASE_STORE_TABLE}?select=value&key=eq.${encodeURIComponent(SUPABASE_STORE_KEY)}&limit=1`;
  const payload = await fetchSupabaseJson(endpoint, { method: 'GET' });
  const row = Array.isArray(payload) ? payload[0] : null;
  return normalizeStore(row?.value || {});
}

async function writeSupabaseStore(store) {
  assertSupabaseStoreConfigured();
  const endpoint = `${SUPABASE_URL}/rest/v1/${SUPABASE_STORE_TABLE}`;
  await fetchSupabaseJson(endpoint, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      key: SUPABASE_STORE_KEY,
      value: store,
      updated_at: store.updatedAt
    })
  });
}

function assertSupabaseStoreConfigured() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase store requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
}

async function fetchSupabaseJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase store ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON from Supabase store');
  }
}

function normalizeStore(store) {
  return {
    schemaVersion: 1,
    createdAt: store.createdAt || new Date().toISOString(),
    updatedAt: store.updatedAt || new Date().toISOString(),
    opportunities: store.opportunities && typeof store.opportunities === 'object' ? store.opportunities : {},
    clients: store.clients && typeof store.clients === 'object' ? store.clients : {},
    llmUsage: Array.isArray(store.llmUsage) ? store.llmUsage : [],
    runs: Array.isArray(store.runs) ? store.runs : [],
    settings: store.settings && typeof store.settings === 'object' ? store.settings : {}
  };
}

function restoreStoredAiAnalysis(jobs, store) {
  const summary = {
    reused: 0,
    changed: 0,
    missing: 0
  };

  for (const job of jobs) {
    const signature = jobContentSignature(job);
    job.aiAnalysisSignature = signature;
    const opportunity = store.opportunities[String(job.id)];
    const storedAnalysis = opportunity?.aiAnalysis;

    if (!storedAnalysis || storedAnalysis.llmReview?.status !== 'reviewed') {
      summary.missing += 1;
      continue;
    }

    if (opportunity.aiAnalysisSignature !== signature) {
      summary.changed += 1;
      continue;
    }

    job.aiAnalysis = {
      ...job.aiAnalysis,
      ...storedAnalysis,
      emailDraft: storedAnalysis.emailDraft || job.aiAnalysis?.emailDraft
    };
    summary.reused += 1;
  }

  return summary;
}

function needsLlmReview(job, store, config) {
  if (config.provider === 'rule') return false;
  if (!LLM_REVIEW_ALL_NEW_JOBS && Number(job.aiAnalysis?.score || 0) < LLM_PREMIUM_SCORE_MIN) return false;
  const signature = job.aiAnalysisSignature || jobContentSignature(job);
  const opportunity = store.opportunities[String(job.id)];
  const storedAnalysis = opportunity?.aiAnalysis;
  const review = storedAnalysis?.llmReview;

  if (!storedAnalysis || !review || review.status !== 'reviewed') return true;
  if (opportunity.aiAnalysisSignature !== signature) return true;
  if (review.provider !== config.provider) return true;
  if (review.model !== config.model) return true;
  if (review.reviewMode !== LLM_REVIEW_MODE) return true;
  if (review.schemaVersion !== LLM_REVIEW_SCHEMA_VERSION) return true;
  return false;
}

function countReusedLlmReviews(jobs) {
  return jobs.filter((job) => job.aiAnalysis?.llmReview?.status === 'reviewed').length;
}

function jobContentSignature(job) {
  return createHash('sha256')
    .update(stableStringify({
      id: job.id,
      title: job.title,
      detail: job.detail,
      hideDetail: job.hideDetail,
      clientId: job.clientId,
      clientName: job.clientName,
      categoryName: job.categoryName,
      skills: job.skills,
      budget: job.budget,
      duration: job.duration,
      location: job.location,
      createdAtSeconds: job.createdAtSeconds,
      latestModifySeconds: job.latestModifySeconds
    }))
    .digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mergeJobsIntoStore(jobs, store) {
  let changed = false;
  const nowIso = new Date().toISOString();

  for (const job of jobs) {
    const jobKey = String(job.id);
    const clientKey = String(job.clientId || 'unknown');
    const client = store.clients[clientKey] || {
      clientId: job.clientId || null,
      name: job.clientName || '',
      email: job.clientEmail || '',
      jobIds: [],
      createdAt: nowIso,
      updatedAt: nowIso
    };

    if (job.clientName && client.name !== job.clientName) {
      client.name = job.clientName;
      changed = true;
    }
    if (job.clientEmail && client.email !== job.clientEmail) {
      client.email = job.clientEmail;
      changed = true;
    }
    if (!client.jobIds.includes(job.id)) {
      client.jobIds.push(job.id);
      changed = true;
    }
    client.lastSeenAt = nowIso;
    client.updatedAt = nowIso;
    store.clients[clientKey] = client;

    const recommendedStatus = recommendedPipelineStatus(job.aiAnalysis?.status);
    let opportunity = store.opportunities[jobKey];
    if (!opportunity) {
      opportunity = {
        jobId: job.id,
        clientId: job.clientId || null,
        aiAnalysis: job.aiAnalysis || null,
        aiAnalysisSignature: jobContentSignature(job),
        aiAnalysisUpdatedAt: nowIso,
        pipelineStatus: recommendedStatus,
        statusUpdatedAt: nowIso,
        notes: '',
        manualPrice: '',
        ownerDecision: '',
        createdAt: nowIso,
        updatedAt: nowIso,
        draft: draftFromAnalysis(job.aiAnalysis, 'generated', nowIso),
        project: null,
        events: [
          {
            id: randomUUID(),
            type: 'created',
            at: nowIso,
            message: `Created from crawl with status ${recommendedStatus}`
          }
        ]
      };
      store.opportunities[jobKey] = opportunity;
      changed = true;
    } else {
      opportunity.clientId = job.clientId || opportunity.clientId || null;
      opportunity.updatedAt = nowIso;
      if (!opportunity.pipelineStatus || !PIPELINE_STATUSES.has(opportunity.pipelineStatus)) {
        opportunity.pipelineStatus = recommendedStatus;
        opportunity.statusUpdatedAt = nowIso;
        changed = true;
      }
      if (!opportunity.draft || opportunity.draft.status === 'generated') {
        opportunity.draft = draftFromAnalysis(job.aiAnalysis, opportunity.draft?.status || 'generated', nowIso, opportunity.draft);
        changed = true;
      }
      const signature = jobContentSignature(job);
      const previousAnalysisText = JSON.stringify(opportunity.aiAnalysis || null);
      const nextAnalysisText = JSON.stringify(job.aiAnalysis || null);
      if (opportunity.aiAnalysisSignature !== signature || previousAnalysisText !== nextAnalysisText) {
        opportunity.aiAnalysis = job.aiAnalysis || null;
        opportunity.aiAnalysisSignature = signature;
        opportunity.aiAnalysisUpdatedAt = nowIso;
        changed = true;
      }
      if (!Array.isArray(opportunity.events)) opportunity.events = [];
    }

    job.workflow = publicOpportunity(opportunity);
    job.clientProfile = {
      clientId: client.clientId,
      name: client.name,
      email: client.email,
      priorJobCount: client.jobIds.length
    };
  }

  store.runs.unshift({
    id: randomUUID(),
    at: nowIso,
    type: 'crawl',
    jobCount: jobs.length,
    easy: jobs.filter((job) => job.aiAnalysis?.status === 'easy').length,
    needsInfo: jobs.filter((job) => job.aiAnalysis?.status === 'needs_info').length,
    hard: jobs.filter((job) => job.aiAnalysis?.status === 'hard').length,
    notFit: jobs.filter((job) => job.aiAnalysis?.status === 'not_fit').length
  });
  store.runs = store.runs.slice(0, 50);
  changed = true;

  return { changed };
}

function draftFromAnalysis(analysis = {}, status = 'generated', nowIso = new Date().toISOString(), previous = {}) {
  const draft = analysis.emailDraft || {};
  return {
    type: draft.type || previous.type || 'clarify',
    subject: draft.subject || previous.subject || '',
    body: normalizeOwnerSignature(draft.body || previous.body || ''),
    status: DRAFT_STATUSES.has(status) ? status : 'generated',
    source: analysis.llmReview?.provider || previous.source || 'rule',
    generatedAt: previous.generatedAt || nowIso,
    updatedAt: nowIso,
    approvedAt: previous.approvedAt || null,
    copiedAt: previous.copiedAt || null
  };
}

function publicOpportunity(opportunity) {
  return {
    jobId: opportunity.jobId,
    clientId: opportunity.clientId,
    pipelineStatus: opportunity.pipelineStatus,
    statusUpdatedAt: opportunity.statusUpdatedAt,
    notes: opportunity.notes || '',
    manualPrice: opportunity.manualPrice || '',
      ownerDecision: opportunity.ownerDecision || '',
      draft: opportunity.draft ? normalizeDraftForDisplay(opportunity.draft) : null,
      project: opportunity.project ? publicProject(opportunity.project) : null,
      eventCount: Array.isArray(opportunity.events) ? opportunity.events.length : 0,
      events: Array.isArray(opportunity.events) ? opportunity.events.slice(0, 50).map(publicEvent) : [],
      updatedAt: opportunity.updatedAt
    };
}

function publicEvent(event = {}) {
  return {
    id: stringValue(event.id),
    type: stringValue(event.type),
    at: stringValue(event.at),
    message: stringValue(event.message),
    channel: stringValue(event.channel),
    direction: stringValue(event.direction),
    subject: stringValue(event.subject),
    body: stringValue(event.body),
    actor: stringValue(event.actor)
  };
}

function normalizeDraftForDisplay(draft) {
  return {
    ...draft,
    body: normalizeOwnerSignature(draft.body || '')
  };
}

function normalizeOwnerSignature(body) {
  const signature = `${OUTREACH_OWNER_NAME}\n${OUTREACH_OWNER_PHONE}`;
  return stringValue(body)
    .replace(/\[你的名字\]/g, signature)
    .replace(/\[你嘅名字\]/g, signature)
    .replace(/\[Your Name\]/gi, signature);
}

function publicProject(project) {
  const normalized = normalizeProject(project);
  return {
    projectStatus: normalized.projectStatus,
    folderPath: normalized.folderPath,
    folderName: normalized.folderName,
    managerNotes: normalized.managerNotes,
    conversation: normalized.conversation,
    taskPlan: normalized.taskPlan,
    deliverablesNote: normalized.deliverablesNote,
    workerPrompt: normalized.workerPrompt,
    hermesHandoff: normalized.hermesHandoff,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    filesSyncedAt: normalized.filesSyncedAt
  };
}

function recommendedPipelineStatus(aiStatus) {
  if (aiStatus === 'easy') return 'shortlisted';
  if (aiStatus === 'needs_info') return 'needs_info';
  if (aiStatus === 'hard') return 'new';
  if (aiStatus === 'not_fit') return 'archived';
  return 'new';
}

function buildPipelineSummary(jobs) {
  const counts = Object.fromEntries([...PIPELINE_STATUSES].map((status) => [status, 0]));
  for (const job of jobs) {
    const status = job.workflow?.pipelineStatus || recommendedPipelineStatus(job.aiAnalysis?.status);
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    counts,
    approvalQueue: (counts.shortlisted || 0) + (counts.needs_info || 0) + (counts.drafted || 0),
    approved: counts.approved || 0,
    sent: counts.sent || 0,
    won: counts.won || 0,
    lost: counts.lost || 0
  };
}

function summarizeStore(store) {
  const opportunities = Object.values(store.opportunities);
  const statusCounts = Object.fromEntries([...PIPELINE_STATUSES].map((status) => [status, 0]));
  for (const opportunity of opportunities) {
    const status = PIPELINE_STATUSES.has(opportunity.pipelineStatus) ? opportunity.pipelineStatus : 'new';
    statusCounts[status] += 1;
  }

  return {
    schemaVersion: store.schemaVersion,
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
    counts: {
      opportunities: opportunities.length,
      clients: Object.keys(store.clients).length,
      statuses: statusCounts,
      llmUsageEvents: store.llmUsage.length,
      runs: store.runs.length
    },
    llm: {
      todayUsd: usageTotal(store, 'day'),
      monthUsd: usageTotal(store, 'month'),
      dailyCapUsd: LLM_DAILY_USD_CAP,
      monthlyCapUsd: LLM_MONTHLY_USD_CAP
    },
    lastRun: store.runs[0] || null
  };
}

async function updateOpportunityState(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const pipelineStatus = String(body.pipelineStatus || '').trim();
  if (pipelineStatus && !PIPELINE_STATUSES.has(pipelineStatus)) {
    return invalidRequest(`Invalid pipelineStatus: ${pipelineStatus}`);
  }

  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const nowIso = new Date().toISOString();
  const beforeStatus = opportunity.pipelineStatus;

  if (pipelineStatus && opportunity.pipelineStatus !== pipelineStatus) {
    opportunity.pipelineStatus = pipelineStatus;
    opportunity.statusUpdatedAt = nowIso;
    pushEvent(opportunity, 'status_changed', `Pipeline status changed from ${beforeStatus || 'none'} to ${pipelineStatus}`);
  }

  if ('notes' in body) opportunity.notes = stringValue(body.notes).slice(0, 5000);
  if ('manualPrice' in body) opportunity.manualPrice = stringValue(body.manualPrice).slice(0, 500);
  if ('ownerDecision' in body) opportunity.ownerDecision = stringValue(body.ownerDecision).slice(0, 500);
  opportunity.updatedAt = nowIso;

  await writeStore(store);
  return { ok: true, opportunity: publicOpportunity(opportunity) };
}

async function updateDraft(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const subject = stringValue(body.subject).slice(0, 500);
  const draftBody = stringValue(body.body).slice(0, 10000);
  if (!subject && !draftBody) return invalidRequest('subject or body is required');

  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const nowIso = new Date().toISOString();
  opportunity.draft = {
    ...(opportunity.draft || {}),
    type: body.type || opportunity.draft?.type || 'clarify',
    subject,
    body: draftBody,
    status: 'edited',
    source: opportunity.draft?.source || 'manual',
    generatedAt: opportunity.draft?.generatedAt || nowIso,
    updatedAt: nowIso,
    approvedAt: null,
    copiedAt: opportunity.draft?.copiedAt || null
  };
  opportunity.pipelineStatus = opportunity.pipelineStatus === 'archived' ? 'drafted' : opportunity.pipelineStatus;
  opportunity.updatedAt = nowIso;
  pushEvent(opportunity, 'draft_edited', 'Draft edited locally');

  await writeStore(store);
  return { ok: true, opportunity: publicOpportunity(opportunity) };
}

async function approveDraft(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const nowIso = new Date().toISOString();

  if (!opportunity.draft?.subject || !opportunity.draft?.body) {
    return invalidRequest('Cannot approve an empty draft');
  }

  opportunity.draft.status = 'approved';
  opportunity.draft.approvedAt = nowIso;
  opportunity.draft.updatedAt = nowIso;
  opportunity.pipelineStatus = 'approved';
  opportunity.statusUpdatedAt = nowIso;
  opportunity.updatedAt = nowIso;
  pushEvent(opportunity, 'draft_approved', 'Draft approved by human. No email was sent.');

  await writeStore(store);
  return { ok: true, opportunity: publicOpportunity(opportunity), sideEffect: 'none_email_not_sent' };
}

async function recordDraftCopied(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const nowIso = new Date().toISOString();
  if (!opportunity.draft) opportunity.draft = draftFromAnalysis({}, 'generated', nowIso);
  opportunity.draft.copiedAt = nowIso;
  opportunity.draft.status = opportunity.draft.status === 'approved' ? 'approved' : 'copied';
  opportunity.updatedAt = nowIso;
  pushEvent(opportunity, 'draft_copied', 'Draft copied locally. No email was sent.');

  await writeStore(store);
  return { ok: true, opportunity: publicOpportunity(opportunity), sideEffect: 'none_email_not_sent' };
}

async function recordCommunication(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const channel = COMMUNICATION_CHANNELS.has(stringValue(body.channel)) ? stringValue(body.channel) : 'other';
  const direction = COMMUNICATION_DIRECTIONS.has(stringValue(body.direction)) ? stringValue(body.direction) : 'internal';
  const subject = stringValue(body.subject).slice(0, 500);
  const messageBody = stringValue(body.body).slice(0, 20000);
  const actor = stringValue(body.actor || OUTREACH_OWNER_NAME).slice(0, 200);

  if (!subject && !messageBody) return invalidRequest('subject or body is required');

  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const nowIso = new Date().toISOString();
  const label = channelLabel(channel);
  const directionText = direction === 'outbound' ? 'sent' : direction === 'inbound' ? 'received' : 'noted';

  pushEvent(opportunity, 'communication_logged', `${label} ${directionText}: ${subject || messageBody.slice(0, 80)}`, {
    channel,
    direction,
    subject,
    body: messageBody,
    actor
  });

  if (direction === 'outbound' && channel === 'email') {
    if (!opportunity.draft) opportunity.draft = draftFromAnalysis({}, 'generated', nowIso);
    opportunity.draft.status = 'copied';
    opportunity.draft.copiedAt = opportunity.draft.copiedAt || nowIso;
    opportunity.pipelineStatus = 'sent';
    opportunity.statusUpdatedAt = nowIso;
  } else if (direction === 'inbound') {
    opportunity.pipelineStatus = 'replied';
    opportunity.statusUpdatedAt = nowIso;
  }

  opportunity.updatedAt = nowIso;
  await writeStore(store);
  return { ok: true, opportunity: publicOpportunity(opportunity), sideEffect: 'local_log_only' };
}

function channelLabel(channel) {
  const labels = {
    email: 'Email',
    whatsapp: 'WhatsApp',
    freehunter: 'Freehunter',
    phone: 'Phone',
    agent_note: 'Agent note',
    other: 'Communication'
  };
  return labels[channel] || labels.other;
}

async function updateProject(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const job = normalizeProjectJobSnapshot(body.job || {}, jobId);
  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const nowIso = new Date().toISOString();
  const existingProject = normalizeProject(opportunity.project);
  const projectStatus = normalizeProjectStatus(body.projectStatus || existingProject.projectStatus);
  const createWorkspace = Boolean(body.createWorkspace);
  const syncFiles = createWorkspace || Boolean(existingProject.folderPath && body.syncFiles !== false);
  const folderName = existingProject.folderName || (createWorkspace ? makeProjectFolderName(jobId, job.title) : '');
  const folderPath = existingProject.folderPath || (createWorkspace ? path.join(PROJECTS_DIR, folderName) : '');
  const taskPlan = stringValue(body.taskPlan || existingProject.taskPlan || buildDefaultTaskPlan(job)).slice(0, 20000);
  const conversation = stringValue(body.conversation ?? existingProject.conversation).slice(0, 30000);
  const managerNotes = stringValue(body.managerNotes ?? existingProject.managerNotes).slice(0, 10000);
  const deliverablesNote = stringValue(body.deliverablesNote ?? existingProject.deliverablesNote).slice(0, 10000);

  opportunity.project = {
    ...existingProject,
    projectStatus,
    folderName,
    folderPath,
    managerNotes,
    conversation,
    taskPlan,
    deliverablesNote,
    workerPrompt: buildWorkerPrompt(job, { ...opportunity, project: existingProject }, {
      projectStatus,
      conversation,
      taskPlan,
      deliverablesNote,
      managerNotes,
      folderPath
    }),
    createdAt: existingProject.createdAt || nowIso,
    updatedAt: nowIso
  };

  if (createWorkspace && opportunity.pipelineStatus === 'new') {
    opportunity.pipelineStatus = 'drafted';
    opportunity.statusUpdatedAt = nowIso;
  }

  if (syncFiles) {
    await writeProjectWorkspace(job, opportunity);
    opportunity.project.filesSyncedAt = nowIso;
  }

  opportunity.updatedAt = nowIso;
  pushEvent(opportunity, createWorkspace ? 'project_created' : 'project_updated', createWorkspace
    ? 'Project workspace created locally. No client was contacted.'
    : 'Project workspace updated locally.');

  await writeStore(store);
  return {
    ok: true,
    opportunity: publicOpportunity(opportunity),
    sideEffect: 'local_files_only'
  };
}

async function handoffToHermes(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const selectedStatus = normalizeProjectStatus(body.projectStatus);
  const projectStatus = selectedStatus === 'not_started' ? 'ready_for_worker' : selectedStatus;
  const projectResult = await updateProject({
    ...body,
    createWorkspace: true,
    syncFiles: true,
    projectStatus
  });

  if (!projectResult.ok) return projectResult;

  const job = normalizeProjectJobSnapshot(body.job || {}, jobId);
  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const project = normalizeProject(opportunity.project);
  const nowIso = new Date().toISOString();
  const handoffId = randomUUID();
  let outboxResult = null;
  let webhookResult = null;

  if (HERMES_HANDOFF_MODE === 'file' || HERMES_HANDOFF_MODE === 'both') {
    outboxResult = await writeHermesOutbox(job, opportunity, project, handoffId);
  }

  if (HERMES_HANDOFF_MODE === 'webhook' || HERMES_HANDOFF_MODE === 'both') {
    webhookResult = HERMES_AGENT_WEBHOOK_URL
      ? await postHermesWebhook(buildHermesHandoffPayload(job, opportunity, project, handoffId, outboxResult?.folderPath || ''))
      : { ok: false, status: 'not_configured', message: 'HERMES_AGENT_WEBHOOK_URL is not configured' };
  }

  const webhookOk = !webhookResult || webhookResult.ok;
  const fileOk = !outboxResult || outboxResult.ok;
  const status = fileOk && webhookOk ? 'ready' : 'needs_attention';
  const messageParts = [
    outboxResult?.folderPath ? `Outbox: ${outboxResult.folderPath}` : '',
    webhookResult ? `Webhook: ${webhookResult.ok ? 'posted' : webhookResult.status || 'failed'}` : ''
  ].filter(Boolean);

  opportunity.project = {
    ...project,
    hermesHandoff: {
      status,
      mode: HERMES_HANDOFF_MODE,
      outboxPath: outboxResult?.folderPath || '',
      webhookStatus: webhookResult ? (webhookResult.ok ? 'posted' : webhookResult.status || 'failed') : '',
      handoffId,
      updatedAt: nowIso,
      message: messageParts.join(' · ') || 'Hermes handoff generated locally.'
    },
    updatedAt: nowIso
  };
  opportunity.pipelineStatus = opportunity.pipelineStatus === 'new' ? 'drafted' : opportunity.pipelineStatus;
  opportunity.updatedAt = nowIso;
  pushEvent(opportunity, 'hermes_handoff_created', opportunity.project.hermesHandoff.message, {
    actor: 'Dashboard',
    direction: 'internal',
    subject: 'Hermes handoff',
    body: buildHermesEventBody(job, opportunity.project.hermesHandoff)
  });

  await writeStore(store);
  return {
    ok: true,
    opportunity: publicOpportunity(opportunity),
    handoff: {
      id: handoffId,
      mode: HERMES_HANDOFF_MODE,
      status,
      outboxPath: outboxResult?.folderPath || '',
      webhook: webhookResult || null
    },
    sideEffect: HERMES_HANDOFF_MODE === 'webhook' ? 'webhook_only' : HERMES_HANDOFF_MODE === 'both' ? 'local_files_and_webhook' : 'local_files_only'
  };
}

async function cancelHermesHandoff(body) {
  const jobId = Number(body.jobId);
  if (!jobId) return invalidRequest('jobId is required');

  const store = await readStore();
  const opportunity = ensureOpportunity(store, jobId);
  const job = normalizeProjectJobSnapshot(body.job || {}, jobId);
  const existingProject = normalizeProject(opportunity.project);
  const nowIso = new Date().toISOString();
  const reason = stringValue(body.reason || 'Jack decided not to pursue this opportunity.').slice(0, 1000);
  const project = {
    ...existingProject,
    projectStatus: 'paused',
    hermesHandoff: {
      ...existingProject.hermesHandoff,
      status: 'cancelled',
      mode: existingProject.hermesHandoff.mode || HERMES_HANDOFF_MODE,
      updatedAt: nowIso,
      message: `Cancelled: ${reason}`,
      cancelledAt: nowIso,
      cancelReason: reason
    },
    updatedAt: nowIso
  };

  let outboxResult = null;
  let webhookResult = null;
  if (HERMES_HANDOFF_MODE === 'file' || HERMES_HANDOFF_MODE === 'both') {
    outboxResult = await writeHermesCancelMarker(job, opportunity, project, reason);
    project.hermesHandoff.outboxPath = outboxResult.folderPath || project.hermesHandoff.outboxPath || '';
  }

  if (HERMES_HANDOFF_MODE === 'webhook' || HERMES_HANDOFF_MODE === 'both') {
    webhookResult = HERMES_AGENT_WEBHOOK_URL
      ? await postHermesWebhook(buildHermesCancelPayload(job, opportunity, project, reason, outboxResult?.folderPath || ''))
      : { ok: false, status: 'not_configured', message: 'HERMES_AGENT_WEBHOOK_URL is not configured' };
    project.hermesHandoff.webhookStatus = webhookResult.ok ? 'cancel_posted' : webhookResult.status || 'cancel_failed';
  }

  opportunity.project = project;
  opportunity.pipelineStatus = 'archived';
  opportunity.statusUpdatedAt = nowIso;
  opportunity.updatedAt = nowIso;

  pushEvent(opportunity, 'hermes_handoff_cancelled', project.hermesHandoff.message, {
    actor: 'Dashboard',
    direction: 'internal',
    subject: 'Hermes handoff cancelled',
    body: [
      `Reason: ${reason}`,
      `Outbox: ${project.hermesHandoff.outboxPath || '-'}`,
      `Webhook: ${project.hermesHandoff.webhookStatus || '-'}`
    ].join('\n')
  });

  await writeStore(store);
  return {
    ok: true,
    opportunity: publicOpportunity(opportunity),
    cancel: {
      status: 'cancelled',
      reason,
      outboxPath: project.hermesHandoff.outboxPath || '',
      webhook: webhookResult || null
    },
    sideEffect: HERMES_HANDOFF_MODE === 'webhook' ? 'webhook_only' : HERMES_HANDOFF_MODE === 'both' ? 'local_files_and_webhook' : 'local_files_only'
  };
}

async function writeHermesOutbox(job, opportunity, project, handoffId) {
  const outboxRoot = path.resolve(HERMES_OUTBOX_DIR);
  const folderName = project.folderName || makeProjectFolderName(job.id, job.title);
  const folderPath = path.join(outboxRoot, folderName);
  const payload = buildHermesHandoffPayload(job, opportunity, project, handoffId, folderPath);

  await mkdir(folderPath, { recursive: true });
  await writeFile(path.join(folderPath, 'handoff.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'handoff.md'), `${buildHermesHandoffMarkdown(payload)}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'worker-prompt.md'), `${project.workerPrompt || buildWorkerPrompt(job, opportunity, project)}\n`, 'utf8');

  return {
    ok: true,
    folderPath,
    files: ['handoff.json', 'handoff.md', 'worker-prompt.md'].map((file) => path.join(folderPath, file))
  };
}

async function writeHermesCancelMarker(job, opportunity, project, reason) {
  const outboxRoot = path.resolve(HERMES_OUTBOX_DIR);
  const folderName = project.folderName || makeProjectFolderName(job.id, job.title);
  const folderPath = project.hermesHandoff.outboxPath || path.join(outboxRoot, folderName);
  const payload = buildHermesCancelPayload(job, opportunity, project, reason, folderPath);

  await mkdir(folderPath, { recursive: true });
  await writeFile(path.join(folderPath, 'cancelled.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'cancelled.md'), `${buildHermesCancelMarkdown(payload)}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'STATUS.cancelled.txt'), `${reason}\n`, 'utf8');

  return {
    ok: true,
    folderPath,
    files: ['cancelled.json', 'cancelled.md', 'STATUS.cancelled.txt'].map((file) => path.join(folderPath, file))
  };
}

function buildHermesCancelPayload(job, opportunity, project, reason, outboxPath = '') {
  return {
    type: 'freehunter.hermes_cancel',
    version: 1,
    createdAt: new Date().toISOString(),
    reason,
    dashboard: {
      url: process.env.DASHBOARD_URL || `http://${HOST}:${PORT}`,
      communicationApi: '/api/communication',
      projectApi: '/api/project'
    },
    job: {
      id: job.id,
      title: job.title,
      clientName: job.clientName,
      clientEmail: job.clientEmail,
      clientId: job.clientId
    },
    workflow: {
      pipelineStatus: 'archived',
      previousPipelineStatus: opportunity.pipelineStatus || '',
      projectStatus: 'paused'
    },
    project: {
      folderPath: project.folderPath,
      outboxPath
    },
    managerInstructions: [
      'Stop processing this opportunity.',
      'Do not send any client-facing message or deliverable for this job.',
      'If a worker was already assigned, tell the worker to pause and summarize any partial work.',
      'Log an internal note back to the dashboard if any action had already started.'
    ]
  };
}

function buildHermesHandoffPayload(job, opportunity, project, handoffId, outboxPath = '') {
  const projectFolder = path.resolve(project.folderPath || path.join(PROJECTS_DIR, project.folderName || makeProjectFolderName(job.id, job.title)));
  return {
    type: 'freehunter.hermes_handoff',
    version: 1,
    handoffId,
    createdAt: new Date().toISOString(),
    dashboard: {
      url: process.env.DASHBOARD_URL || `http://${HOST}:${PORT}`,
      jobApi: '/api/jobs',
      communicationApi: '/api/communication',
      projectApi: '/api/project'
    },
    owner: {
      name: OUTREACH_OWNER_NAME,
      phone: OUTREACH_OWNER_PHONE
    },
    job: {
      id: job.id,
      title: job.title,
      clientName: job.clientName,
      clientEmail: job.clientEmail,
      clientId: job.clientId,
      budget: job.budget,
      categoryName: job.categoryName,
      skills: job.skills,
      detail: job.detail,
      hideDetail: job.hideDetail
    },
    workflow: {
      pipelineStatus: opportunity.pipelineStatus,
      manualPrice: opportunity.manualPrice || '',
      notes: opportunity.notes || '',
      draft: opportunity.draft || null
    },
    project: {
      status: project.projectStatus,
      folderPath: projectFolder,
      outboxPath,
      managerNotes: project.managerNotes,
      conversation: project.conversation,
      taskPlan: project.taskPlan,
      deliverablesNote: project.deliverablesNote
    },
    aiAnalysis: job.aiAnalysis,
    files: {
      brief: path.join(projectFolder, 'brief.md'),
      conversation: path.join(projectFolder, 'conversation.md'),
      tasks: path.join(projectFolder, 'tasks.md'),
      workerPrompt: path.join(projectFolder, 'worker-prompt.md'),
      questions: path.join(projectFolder, 'questions.md'),
      progress: path.join(projectFolder, 'progress.md'),
      workerHandoff: path.join(projectFolder, 'handoff.md'),
      deliverables: path.join(projectFolder, 'deliverables')
    },
    managerInstructions: [
      'Act as the always-on manager for this opportunity.',
      'Read the project folder before asking Jack anything.',
      'If the brief is not enough, consolidate questions into one short message for Jack.',
      'If the task needs implementation, hand worker-prompt.md to Codex or another worker.',
      'Do not send client-facing email or deliverables unless the dashboard status and Jack approval allow it.',
      'After any email, WhatsApp, Freehunter reply, or internal decision, write it back to the dashboard communication timeline.'
    ],
    codexHandoffRule: 'Codex should work inside project.folderPath, update progress.md/questions.md/handoff.md, and leave client-facing copy for Hermes/Jack approval.'
  };
}

async function postHermesWebhook(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(HERMES_AGENT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(HERMES_AGENT_TOKEN ? { Authorization: `Bearer ${HERMES_AGENT_TOKEN}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: `${response.status} ${response.statusText}`.trim(),
      response: text.slice(0, 1000)
    };
  } catch (error) {
    return {
      ok: false,
      status: 'request_failed',
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildHermesHandoffMarkdown(payload) {
  const draft = payload.workflow.draft || {};
  return [
    `# Hermes Handoff: ${payload.job.title}`,
    '',
    `- Handoff ID: ${payload.handoffId}`,
    `- Job ID: ${payload.job.id}`,
    `- Client: ${payload.job.clientName || '-'} <${payload.job.clientEmail || '-'}>`,
    `- Pipeline: ${payload.workflow.pipelineStatus || '-'}`,
    `- Project status: ${payload.project.status || '-'}`,
    `- Project folder: ${payload.project.folderPath}`,
    '',
    '## Manager Mission',
    markdownList(payload.managerInstructions),
    '',
    '## Current Draft',
    draft.body ? [`Subject: ${draft.subject || '-'}`, '', draft.body].join('\n') : '-',
    '',
    '## Codex Handoff Rule',
    payload.codexHandoffRule,
    '',
    '## Key Files',
    Object.entries(payload.files).map(([label, filePath]) => `- ${label}: ${filePath}`).join('\n'),
    '',
    '## Conversation',
    payload.project.conversation || '-',
    '',
    '## Task Plan',
    payload.project.taskPlan || '-'
  ].join('\n');
}

function buildHermesCancelMarkdown(payload) {
  return [
    `# Cancel Hermes Handoff: ${payload.job.title}`,
    '',
    `- Job ID: ${payload.job.id}`,
    `- Client: ${payload.job.clientName || '-'} <${payload.job.clientEmail || '-'}>`,
    `- Status: archived / paused`,
    `- Created at: ${payload.createdAt}`,
    '',
    '## Reason',
    payload.reason || '-',
    '',
    '## Instructions',
    markdownList(payload.managerInstructions)
  ].join('\n');
}

function buildHermesEventBody(job, meta) {
  return [
    `Job #${job.id}: ${job.title}`,
    `Mode: ${meta.mode || '-'}`,
    `Status: ${meta.status || '-'}`,
    `Outbox: ${meta.outboxPath || '-'}`,
    `Webhook: ${meta.webhookStatus || '-'}`,
    `Handoff ID: ${meta.handoffId || '-'}`
  ].join('\n');
}

function normalizeProject(project = {}) {
  project = project && typeof project === 'object' ? project : {};
  const nowIso = new Date().toISOString();
  return {
    projectStatus: normalizeProjectStatus(project.projectStatus),
    folderPath: stringValue(project.folderPath),
    folderName: stringValue(project.folderName),
    managerNotes: stringValue(project.managerNotes),
    conversation: stringValue(project.conversation),
    taskPlan: stringValue(project.taskPlan),
    deliverablesNote: stringValue(project.deliverablesNote),
    workerPrompt: stringValue(project.workerPrompt),
    hermesHandoff: normalizeHermesHandoffMeta(project.hermesHandoff),
    createdAt: project.createdAt || nowIso,
    updatedAt: project.updatedAt || nowIso,
    filesSyncedAt: project.filesSyncedAt || null
  };
}

function normalizeHermesHandoffMeta(value = {}) {
  const meta = value && typeof value === 'object' ? value : {};
  return {
    status: stringValue(meta.status),
    mode: stringValue(meta.mode),
    outboxPath: stringValue(meta.outboxPath),
    webhookStatus: stringValue(meta.webhookStatus),
    handoffId: stringValue(meta.handoffId),
    updatedAt: meta.updatedAt || null,
    message: stringValue(meta.message),
    cancelledAt: meta.cancelledAt || null,
    cancelReason: stringValue(meta.cancelReason)
  };
}

function normalizeProjectStatus(value) {
  const status = stringValue(value || 'not_started');
  return PROJECT_STATUSES.has(status) ? status : 'not_started';
}

function normalizeProjectJobSnapshot(rawJob, jobId) {
  const analysis = rawJob.aiAnalysis && typeof rawJob.aiAnalysis === 'object' ? rawJob.aiAnalysis : {};
  return {
    id: jobId,
    title: stringValue(rawJob.title || `Job ${jobId}`).slice(0, 500),
    detail: stringValue(rawJob.detail).slice(0, 30000),
    hideDetail: stringValue(rawJob.hideDetail).slice(0, 30000),
    clientName: stringValue(rawJob.clientName).slice(0, 200),
    clientEmail: stringValue(rawJob.clientEmail).slice(0, 300),
    clientId: rawJob.clientId || null,
    categoryName: stringValue(rawJob.categoryName).slice(0, 200),
    skills: Array.isArray(rawJob.skills) ? rawJob.skills.map(stringValue).slice(0, 20) : [],
    budget: stringValue(rawJob.budget).slice(0, 200),
    duration: stringValue(rawJob.duration).slice(0, 100),
    location: stringValue(rawJob.location).slice(0, 200),
    aiAnalysis: {
      status: stringValue(analysis.status),
      score: Number.isFinite(Number(analysis.score)) ? Number(analysis.score) : 0,
      summary: stringValue(analysis.summary),
      aiCanDo: Array.isArray(analysis.aiCanDo) ? analysis.aiCanDo.map(stringValue).slice(0, 10) : [],
      humanNeeds: Array.isArray(analysis.humanNeeds) ? analysis.humanNeeds.map(stringValue).slice(0, 10) : [],
      missingInfo: Array.isArray(analysis.missingInfo) ? analysis.missingInfo.map(stringValue).slice(0, 10) : [],
      risks: Array.isArray(analysis.risks) ? analysis.risks.map(stringValue).slice(0, 10) : [],
      recommendedNextStep: stringValue(analysis.recommendedNextStep),
      pricingHint: stringValue(analysis.pricingHint),
      quoteRecommendation: analysis.quoteRecommendation && typeof analysis.quoteRecommendation === 'object' ? analysis.quoteRecommendation : null,
      executionPlan: Array.isArray(analysis.executionPlan) ? analysis.executionPlan.map(stringValue).slice(0, 10) : []
    }
  };
}

function makeProjectFolderName(jobId, title) {
  const safeTitle = stringValue(title)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${jobId}-${safeTitle || 'project'}`;
}

function buildDefaultTaskPlan(job) {
  const analysis = job.aiAnalysis || {};
  const missingInfo = Array.isArray(analysis.missingInfo) ? analysis.missingInfo : [];
  const aiCanDo = Array.isArray(analysis.aiCanDo) ? analysis.aiCanDo : [];
  const tasks = [
    '- [ ] Confirm scope, deadline, budget, and acceptance criteria.',
    '- [ ] Draft a concise Cantonese client reply for human approval.',
    '- [ ] Prepare quote stance and delivery timeline.'
  ];

  if (missingInfo.length) {
    tasks.push(...missingInfo.slice(0, 4).map((item) => `- [ ] Ask client: ${item}`));
  }

  if (aiCanDo.length) {
    tasks.push(...aiCanDo.slice(0, 4).map((item) => `- [ ] Worker task: ${item}`));
  }

  tasks.push('- [ ] Human review before any external email or deliverable is sent.');
  return tasks.join('\n');
}

function buildWorkerPrompt(job, opportunity, project) {
  const analysis = job.aiAnalysis || {};
  return [
    `You are a worker agent for Freehunter job #${job.id}.`,
    '',
    'Goal:',
    `Help prepare this freelance project for delivery. Work only inside this project folder unless explicitly instructed otherwise.`,
    '',
    'Guardrails:',
    '- Do not send emails, submit forms, contact the client, or publish files externally.',
    '- Produce drafts, files, plans, and verification notes for human approval.',
    '- Keep client-facing Cantonese natural, concise, and non-AI-sounding.',
    '- When blocked, write exactly what human input is needed.',
    '',
    'Job:',
    `Title: ${job.title}`,
    `Client: ${job.clientName || '-'} <${job.clientEmail || '-'}>`,
    `Budget: ${job.budget || '-'}`,
    `Category: ${job.categoryName || '-'}`,
    `Skills: ${job.skills.join(', ') || '-'}`,
    '',
    'AI analysis:',
    `Fit: ${analysis.status || '-'} (${analysis.score || 0}/100)`,
    `Summary: ${analysis.summary || '-'}`,
    `Pricing hint: ${analysis.pricingHint || '-'}`,
    `Quote: ${analysis.quoteRecommendation?.quoteLine || analysis.quoteRecommendation?.range || '-'}`,
    '',
    'Current project status:',
    project.projectStatus || 'not_started',
    '',
    'Manager notes:',
    project.managerNotes || '-',
    '',
    'Client conversation:',
    project.conversation || '-',
    '',
    'Task plan:',
    project.taskPlan || buildDefaultTaskPlan(job),
    '',
    'Deliverables note:',
    project.deliverablesNote || '-',
    '',
    'Original job detail:',
    job.detail || '-',
    '',
    'Client/company notes:',
    job.hideDetail || '-'
  ].join('\n');
}

async function writeProjectWorkspace(job, opportunity) {
  const project = normalizeProject(opportunity.project);
  const root = path.resolve(PROJECTS_DIR);
  const folderPath = path.resolve(project.folderPath || path.join(PROJECTS_DIR, makeProjectFolderName(job.id, job.title)));
  if (!folderPath.startsWith(`${root}${path.sep}`) && folderPath !== root) {
    throw new Error('Project folder must stay inside PROJECTS_DIR');
  }

  await mkdir(path.join(folderPath, 'deliverables'), { recursive: true });
  await mkdir(path.join(folderPath, 'source'), { recursive: true });
  await writeFile(path.join(folderPath, 'brief.md'), buildProjectBriefMarkdown(job, opportunity, project), 'utf8');
  await writeFile(path.join(folderPath, 'conversation.md'), project.conversation || '# Conversation\n\n', 'utf8');
  await writeFile(path.join(folderPath, 'tasks.md'), `${project.taskPlan || buildDefaultTaskPlan(job)}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'worker-prompt.md'), `${project.workerPrompt || buildWorkerPrompt(job, opportunity, project)}\n`, 'utf8');
  await writeFile(path.join(folderPath, 'manager-flow.md'), `${buildManagerFlowMarkdown()}\n`, 'utf8');
  await writeFileIfMissing(path.join(folderPath, 'questions.md'), '# Questions for Jack / Client\n\n- \n');
  await writeFileIfMissing(path.join(folderPath, 'progress.md'), '# Progress\n\n- [ ] Workspace created\n');
  await writeFileIfMissing(path.join(folderPath, 'handoff.md'), '# Worker Handoff\n\nPending.\n');
  await writeFile(
    path.join(folderPath, 'deliverables', 'README.md'),
    `${project.deliverablesNote || 'Deliverables and export notes will be tracked here.'}\n`,
    'utf8'
  );
}

async function writeFileIfMissing(filePath, content) {
  try {
    await readFile(filePath, 'utf8');
  } catch {
    await writeFile(filePath, content, 'utf8');
  }
}

function buildProjectBriefMarkdown(job, opportunity, project) {
  const analysis = job.aiAnalysis || {};
  return [
    `# ${job.title}`,
    '',
    `- Job ID: ${job.id}`,
    `- Client: ${job.clientName || '-'} (${job.clientId || '-'})`,
    `- Email: ${job.clientEmail || '-'}`,
    `- Budget: ${job.budget || '-'}`,
    `- Category: ${job.categoryName || '-'}`,
    `- Skills: ${job.skills.join(', ') || '-'}`,
    `- Pipeline: ${opportunity.pipelineStatus || '-'}`,
    `- Project status: ${project.projectStatus || '-'}`,
    `- AI fit: ${analysis.status || '-'} (${analysis.score || 0}/100)`,
    '',
    '## AI Summary',
    analysis.summary || '-',
    '',
    '## AI Can Do',
    markdownList(analysis.aiCanDo),
    '',
    '## Human Needs',
    markdownList(analysis.humanNeeds),
    '',
    '## Missing Info',
    markdownList(analysis.missingInfo),
    '',
    '## Risks',
    markdownList(analysis.risks),
    '',
    '## Pricing Hint',
    analysis.pricingHint || '-',
    '',
    '## Quote Recommendation',
    analysis.quoteRecommendation?.quoteLine || analysis.quoteRecommendation?.range || '-',
    '',
    '## Execution Plan',
    markdownList(analysis.executionPlan),
    '',
    '## Manager Notes',
    project.managerNotes || '-',
    '',
    '## Job Detail',
    job.detail || '-',
    '',
    '## Client / Company Notes',
    job.hideDetail || '-'
  ].join('\n');
}

function buildManagerFlowMarkdown() {
  return [
    '# Freehunter AI Manager Flow',
    '',
    '1. Dashboard imports Freehunter jobs and client emails.',
    '2. OpenRouter/OpenAI or local rules score each job and prepare a draft stance.',
    '3. Jack reviews promising jobs and approves outreach or clarification.',
    '4. Hermes manages follow-up, inbox monitoring, and client conversation history.',
    '5. When a job is ready to execute, Dashboard creates a project workspace and Hermes handoff.',
    '6. Codex or another worker reads `worker-prompt.md` and works inside the project folder.',
    '7. Worker writes questions to `questions.md`, progress to `progress.md`, and final notes to `handoff.md`.',
    '8. Hermes consolidates questions for Jack, drafts client replies, and records every message in the dashboard timeline.',
    '9. Jack approves external sends, quotes, deliverables, and any commitment that affects money or reputation.',
    '',
    'Hard rules:',
    '',
    '- Do not invent portfolio, credentials, company history, or client references.',
    '- Do not send emails, WhatsApp messages, deliverables, or invoices unless explicitly approved.',
    '- Keep client-facing Cantonese concise, human, practical, and free of AI buzzwords.',
    '- Prefer fixed deliverables, fixed rounds of revision, and clear payment milestones over open-ended hourly work.'
  ].join('\n');
}

function markdownList(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return list.length ? list.map((item) => `- ${item}`).join('\n') : '-';
}

function ensureOpportunity(store, jobId) {
  const key = String(jobId);
  const nowIso = new Date().toISOString();
  if (!store.opportunities[key]) {
    store.opportunities[key] = {
      jobId,
      clientId: null,
      pipelineStatus: 'new',
      statusUpdatedAt: nowIso,
      notes: '',
      manualPrice: '',
      ownerDecision: '',
      createdAt: nowIso,
      updatedAt: nowIso,
      draft: null,
      project: null,
      events: []
    };
    pushEvent(store.opportunities[key], 'created_manual', 'Created by local workflow action');
  }
  if (!Array.isArray(store.opportunities[key].events)) store.opportunities[key].events = [];
  return store.opportunities[key];
}

function pushEvent(opportunity, type, message, extra = {}) {
  if (!Array.isArray(opportunity.events)) opportunity.events = [];
  opportunity.events.unshift({
    id: randomUUID(),
    type,
    at: new Date().toISOString(),
    message,
    ...extra
  });
  opportunity.events = opportunity.events.slice(0, 50);
}

function invalidRequest(message) {
  return {
    ok: false,
    error: 'invalid_request',
    message
  };
}

async function maybeEnhanceJobsWithLlm(jobs, store, { llmLimit = LLM_TRIAGE_MAX_JOBS } = {}) {
  const config = getLlmConfig();
  const effectiveLimit = Number.isFinite(Number(llmLimit)) ? Math.max(0, Math.floor(Number(llmLimit))) : LLM_TRIAGE_MAX_JOBS;
  const summary = {
    provider: config.provider,
    mode: config.mode,
    enabled: config.enabled,
    reviewed: 0,
    errors: 0,
    candidates: 0,
    skippedReason: '',
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    reused: countReusedLlmReviews(jobs),
    pendingReview: 0,
    dailyCapUsd: LLM_DAILY_USD_CAP,
    monthlyCapUsd: LLM_MONTHLY_USD_CAP,
    reviewMode: LLM_REVIEW_MODE,
    reviewAllNewJobs: LLM_REVIEW_ALL_NEW_JOBS,
    schemaVersion: LLM_REVIEW_SCHEMA_VERSION,
    batchLimit: effectiveLimit,
    concurrency: LLM_CONCURRENCY,
    dailyUsedUsd: usageTotal(store, 'day'),
    monthlyUsedUsd: usageTotal(store, 'month')
  };

  const reviewableJobs = jobs.filter((job) => needsLlmReview(job, store, config));
  const candidates = reviewableJobs.slice(0, effectiveLimit);
  summary.candidates = candidates.length;
  summary.pendingReview = reviewableJobs.length;
  summary.estimatedCostUsd = roundMoney(candidates.reduce((sum, job) => sum + estimateLlmCost(job, config), 0));

  if (!config.enabled) {
    summary.skippedReason = config.reason;
    annotateLlmSkipped(jobs.filter((job) => job.aiAnalysis?.llmReview?.status !== 'reviewed'), summary);
    return { changed: false, summary };
  }

  const projectedDaily = summary.dailyUsedUsd + summary.estimatedCostUsd;
  const projectedMonthly = summary.monthlyUsedUsd + summary.estimatedCostUsd;
  if (projectedDaily > LLM_DAILY_USD_CAP || projectedMonthly > LLM_MONTHLY_USD_CAP) {
    summary.skippedReason = 'cost_cap_would_be_exceeded';
    annotateLlmSkipped(jobs.filter((job) => job.aiAnalysis?.llmReview?.status !== 'reviewed'), summary);
    return { changed: false, summary };
  }

  if (!candidates.length) {
    summary.skippedReason = 'no_jobs_needing_llm_review';
    annotateLlmSkipped(jobs.filter((job) => job.aiAnalysis?.llmReview?.status !== 'reviewed'), summary);
    return { changed: false, summary };
  }

  const results = await mapLimit(candidates, Math.max(1, LLM_CONCURRENCY), async (job) => {
    try {
      const review = config.provider === 'mock'
        ? mockLlmReview(job)
        : await reviewJobWithProvider(job, config);
      applyLlmReview(job, review, config.provider);
      const usage = review.usage || {};
      const cost = usage.inputTokens || usage.outputTokens ? costFromUsage(usage, config) : estimateLlmCost(job, config);
      return {
        reviewed: true,
        event: {
          id: randomUUID(),
          at: new Date().toISOString(),
          provider: config.provider,
          model: config.model,
          reviewMode: LLM_REVIEW_MODE,
          schemaVersion: LLM_REVIEW_SCHEMA_VERSION,
          jobId: job.id,
          estimatedUsd: roundMoney(cost),
          actualUsd: usage.actualUsd || 0,
          inputTokens: usage.inputTokens || estimateTokens(buildLlmPrompt(job, LLM_REVIEW_MODE)),
          outputTokens: usage.outputTokens || estimateTokens(JSON.stringify(review)),
          attempts: usage.attempts || 1,
          parseRetries: usage.parseRetries || 0
        }
      };
    } catch (error) {
      job.aiAnalysis.llmReview = {
        provider: config.provider,
        model: config.model,
        reviewMode: LLM_REVIEW_MODE,
        schemaVersion: LLM_REVIEW_SCHEMA_VERSION,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        reviewedAt: new Date().toISOString()
      };
      return { reviewed: false, error: job.aiAnalysis.llmReview.error };
    }
  });

  const usageEvents = results.map((result) => result?.event).filter(Boolean);
  summary.reviewed = results.filter((result) => result?.reviewed).length;
  summary.errors = results.filter((result) => result && !result.reviewed).length;
  const changed = results.length > 0;

  if (usageEvents.length) {
    store.llmUsage.unshift(...usageEvents);
    store.llmUsage = store.llmUsage.slice(0, 500);
    summary.actualCostUsd = roundMoney(usageEvents.reduce((sum, event) => sum + (event.actualUsd || event.estimatedUsd || 0), 0));
    summary.dailyUsedUsd = usageTotal(store, 'day');
    summary.monthlyUsedUsd = usageTotal(store, 'month');
  }

  annotateLlmSkipped(jobs.filter((job) => !job.aiAnalysis?.llmReview), summary);
  return { changed, summary };
}

function annotateLlmSkipped(jobs, summary) {
  for (const job of jobs) {
    job.aiAnalysis.llmReview = {
      provider: summary.provider,
      status: 'skipped',
      reason: summary.skippedReason || 'not_selected_for_premium_review',
      reviewedAt: null
    };
  }
}

function getLlmConfig() {
  if (LLM_ANALYSIS_PROVIDER === 'rule') {
    return {
      provider: 'rule',
      mode: 'local',
      model: 'rule-based',
      enabled: false,
      reason: 'rule_provider_selected'
    };
  }

  if (LLM_ANALYSIS_PROVIDER === 'mock') {
    return {
      provider: 'mock',
      mode: 'mock',
      model: 'mock-reviewer',
      enabled: true,
      reason: ''
    };
  }

  if (LLM_ANALYSIS_PROVIDER === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    return {
      provider: 'openrouter',
      mode: LLM_ENABLE_NETWORK_ANALYSIS ? 'network' : 'configured_off',
      model: process.env.OPENROUTER_ANALYSIS_MODEL || DEFAULT_OPENROUTER_ANALYSIS_MODEL,
      baseUrl: trimTrailingSlash(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
      apiKey,
      enabled: Boolean(apiKey && LLM_ENABLE_NETWORK_ANALYSIS),
      reason: !apiKey ? 'missing_OPENROUTER_API_KEY' : !LLM_ENABLE_NETWORK_ANALYSIS ? 'LLM_ENABLE_NETWORK_ANALYSIS_not_1' : ''
    };
  }

  if (LLM_ANALYSIS_PROVIDER === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY || '';
    return {
      provider: 'openai',
      mode: LLM_ENABLE_NETWORK_ANALYSIS ? 'network' : 'configured_off',
      model: process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5-mini',
      baseUrl: trimTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      apiKey,
      enabled: Boolean(apiKey && LLM_ENABLE_NETWORK_ANALYSIS),
      reason: !apiKey ? 'missing_OPENAI_API_KEY' : !LLM_ENABLE_NETWORK_ANALYSIS ? 'LLM_ENABLE_NETWORK_ANALYSIS_not_1' : ''
    };
  }

  return {
    provider: LLM_ANALYSIS_PROVIDER,
    mode: 'unknown',
    model: '',
    enabled: false,
    reason: `unsupported_provider_${LLM_ANALYSIS_PROVIDER}`
  };
}

function publicLlmConfig() {
  const config = getLlmConfig();
  return {
    provider: config.provider,
    mode: config.mode,
    model: config.model,
    enabled: config.enabled,
    reason: config.reason,
    networkAnalysisEnabled: LLM_ENABLE_NETWORK_ANALYSIS,
    reviewMode: LLM_REVIEW_MODE,
    reviewAllNewJobs: LLM_REVIEW_ALL_NEW_JOBS,
    schemaVersion: LLM_REVIEW_SCHEMA_VERSION,
    jsonRetryOnParseError: LLM_JSON_RETRY_ON_PARSE_ERROR,
    requestTimeoutMs: LLM_REQUEST_TIMEOUT_MS,
    redactsContactInfo: true,
    triageMaxJobs: LLM_TRIAGE_MAX_JOBS,
    concurrency: LLM_CONCURRENCY,
    premiumScoreMin: LLM_PREMIUM_SCORE_MIN,
    dailyUsdCap: LLM_DAILY_USD_CAP,
    monthlyUsdCap: LLM_MONTHLY_USD_CAP
  };
}

function publicHermesConfig() {
  return {
    mode: HERMES_HANDOFF_MODE,
    outboxDir: HERMES_OUTBOX_DIR,
    webhookConfigured: Boolean(HERMES_AGENT_WEBHOOK_URL),
    tokenConfigured: Boolean(HERMES_AGENT_TOKEN),
    requestTimeoutMs: HERMES_REQUEST_TIMEOUT_MS
  };
}

function publicStoreConfig() {
  return {
    provider: STORE_PROVIDER,
    path: STORE_PROVIDER === 'file' ? STORE_PATH : '',
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    supabaseTable: STORE_PROVIDER === 'supabase' ? SUPABASE_STORE_TABLE : '',
    supabaseKey: STORE_PROVIDER === 'supabase' ? SUPABASE_STORE_KEY : '',
    persistent: STORE_PROVIDER === 'supabase' || !IS_VERCEL,
    runtime: IS_VERCEL ? 'vercel' : 'local'
  };
}

function normalizeHermesHandoffMode(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return ['file', 'webhook', 'both', 'disabled'].includes(normalized) ? normalized : 'file';
}

async function reviewJobWithProvider(job, config) {
  const prompt = buildLlmPrompt(job, LLM_REVIEW_MODE);
  const endpoint = `${config.baseUrl}/chat/completions`;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    actualUsd: 0,
    attempts: 0,
    parseRetries: 0
  };
  const payload = {
    model: config.model,
    temperature: 0,
    max_tokens: LLM_REVIEW_MODE === 'analysis_only' ? 900 : 1250,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a strict Hong Kong Cantonese freelance job reviewer. Return one valid JSON object only. No markdown, no code fences, no comments, no extra prose. Never say email has been sent. Keep all Cantonese natural, concise, and non-AI-sounding.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  };

  const first = await callChatCompletion(endpoint, payload, config);
  addUsage(usage, first.usage);

  try {
    const parsed = parseLlmJson(first.content);
    parsed.usage = usage;
    return parsed;
  } catch (firstError) {
    if (!LLM_JSON_RETRY_ON_PARSE_ERROR) throw firstError;

    usage.parseRetries += 1;
    const retryPayload = {
      ...payload,
      max_tokens: LLM_REVIEW_MODE === 'analysis_only' ? 750 : 1050,
      messages: [
        {
          role: 'system',
          content:
            'You repair malformed model output into one valid JSON object. Return JSON only. Preserve the intended values where possible. No markdown.'
        },
        {
          role: 'user',
          content: buildLlmRepairPrompt(job, first.content, firstError)
        }
      ]
    };
    const second = await callChatCompletion(endpoint, retryPayload, config);
    addUsage(usage, second.usage);
    const parsed = parseLlmJson(second.content);
    parsed.usage = usage;
    return parsed;
  }
}

function buildLlmPrompt(job, reviewMode = LLM_REVIEW_MODE) {
  const includeDraft = reviewMode === 'analysis_and_draft';
  const outputShape = {
    status: 'easy|needs_info|hard|not_fit',
    score: '0-100 integer',
    summary: 'one short Cantonese paragraph for internal review',
    aiCanDo: ['short bullets'],
    humanNeeds: ['short bullets'],
    missingInfo: ['short bullets'],
    risks: ['short bullets'],
    recommendedNextStep: 'draft_apply_email|ask_for_details|manual_review|skip',
    pricingHint: 'short Cantonese internal note',
    quoteRecommendation: {
      canQuote: 'boolean - true only when the job has enough scope to give an initial price',
      range: 'HKD price range with negotiation room, e.g. HKD 6,000-9,000',
      quoteLine: 'one concise Cantonese quote sentence',
      assumptions: ['short assumptions'],
      confidence: 'low|medium|high'
    },
    executionPlan: ['3-5 concrete Cantonese steps for how the work would be delivered']
  };

  if (includeDraft) {
    outputShape.emailDraft = {
      type: 'apply|clarify|follow_up|decline|skip',
      subject: 'short subject',
      body: 'Cantonese email body'
    };
  }

  return JSON.stringify(
    {
      task:
        includeDraft
          ? 'Review this Freehunter freelance job for AI-assisted acquisition. Return JSON with analysis and a short outreach draft.'
          : 'Review this Freehunter freelance job for AI-assisted acquisition. Return JSON with analysis only. Do not return emailDraft.',
      reviewMode,
      reviewerGoal:
        'Use one consistent standard to decide whether Jack Lo should contact this client, how much AI leverage exists, what a human must still do, and whether an initial quote is safe.',
      scoringRubric: {
        aiLeverage: '0-35: Can AI produce most of the deliverables remotely? Coding, websites, content, design drafts, image generation, transcription, translation, research, automation, decks and spreadsheets score high. On-site, live performance, physical work, regulated expert advice, or unclear human-only tasks score low.',
        scopeClarity: '0-20: Clear deliverables, quantity, format, deadline, materials and success criteria score high. Vague jobs score lower and should usually be needs_info.',
        commercialValue: '0-15: Higher realistic budget, direct apply, approved status, and long-term potential score high. Finished/pending jobs or tiny budgets score low.',
        deliveryRisk: '0-15: Lower risk means stable scope, realistic timeline, few dependencies, and no special credentials. Urgent, unlimited revisions, unclear ownership, legal/medical/financial claims, or heavy client dependency score lower.',
        closingFit: '0-15: Score whether Jack can sound credible in the first email with a concrete plan and price/questions.'
      },
      scoreBands: {
        '90-100': 'Excellent target. AI can do most work and scope is clear enough to quote.',
        '70-89': 'Worth contacting. Strong AI leverage; quote if enough info, otherwise ask focused questions.',
        '50-69': 'Possible but needs info or careful scope control.',
        '30-49': 'Low priority or hard; manual review before contacting.',
        '0-29': 'Skip unless there is a special reason.'
      },
      decisionRules: [
        'Be conservative. Do not mark a job easy only because AI can help a small part.',
        'If status is finished, usually choose not_fit unless there is a clear reason to follow up.',
        'If the job requires on-site presence, live filming, live teaching, physical delivery, professional licensing, or direct human performance, lower the score and explain the human need.',
        'If information is missing but the job is commercially attractive, use needs_info rather than hard.',
        'Set quoteRecommendation.canQuote true only when the brief has enough scope, quantity, deadline/materials, and output expectations to give an initial range.',
        'When quoting, choose a reasonable HKD range with negotiation room. Do not underprice just to win.',
        'When not quoting, missingInfo must contain the exact questions needed before a price.'
      ],
      allowedStatuses: ['easy', 'needs_info', 'hard', 'not_fit'],
      allowedNextSteps: ['draft_apply_email', 'ask_for_details', 'manual_review', 'skip'],
      styleRules: [
        'All human-facing Cantonese must sound like a real Hong Kong freelancer, not AI.',
        'No AI smell, no buzzwords, no mention of AI unless client asked.',
        'Avoid over-promising. Be practical, warm, and specific.',
        'Do not claim work is done.',
        'Do not send anything; draft only.'
      ],
      outputRules: [
        'Return exactly one JSON object.',
        'Use double quotes for every JSON key and string.',
        'Do not include markdown fences.',
        'Do not include comments.',
        'Do not include trailing commas.',
        'Arrays must contain short strings only.',
        'score must be an integer from 0 to 100.'
      ],
      currentRuleAnalysis: compactRuleAnalysis(job.aiAnalysis),
      job: {
        id: job.id,
        title: job.title,
        detail: sanitizeForLlm(truncateForLlm(job.detail, 5000)),
        hideDetail: sanitizeForLlm(truncateForLlm(job.hideDetail, 1800)),
        clientNameProvided: Boolean(job.clientName),
        clientEmailProvided: Boolean(job.clientEmail),
        categoryName: job.categoryName,
        skills: job.skills,
        budget: job.budget,
        status: job.status,
        duration: job.duration,
        location: job.location
      },
      outputShape
    },
    null,
    2
  );
}

function compactRuleAnalysis(analysis = {}) {
  return {
    status: analysis.status,
    score: analysis.score,
    summary: analysis.summary,
    aiCanDo: Array.isArray(analysis.aiCanDo) ? analysis.aiCanDo.slice(0, 5) : [],
    humanNeeds: Array.isArray(analysis.humanNeeds) ? analysis.humanNeeds.slice(0, 5) : [],
    missingInfo: Array.isArray(analysis.missingInfo) ? analysis.missingInfo.slice(0, 5) : [],
    risks: Array.isArray(analysis.risks) ? analysis.risks.slice(0, 5) : [],
    recommendedNextStep: analysis.recommendedNextStep,
    pricingHint: analysis.pricingHint,
    quoteRecommendation: analysis.quoteRecommendation
  };
}

function truncateForLlm(value, limit) {
  const text = stringValue(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated]`;
}

function sanitizeForLlm(value) {
  return stringValue(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(/(?:\+?852[\s-]?)?\b[235689]\d{3}[\s-]?\d{4}\b/g, '[phone redacted]')
    .replace(/\b(?:whatsapp|wechat|signal|telegram)\s*[:：]?\s*[A-Z0-9_@+\-\s]{4,24}/gi, '[contact redacted]');
}

function parseLlmJson(content) {
  const normalized = stripMarkdownJsonFence(String(content || '').trim());
  const candidates = unique([
    normalized,
    extractBalancedJsonObject(normalized),
    repairLooseJson(normalized),
    repairLooseJson(extractBalancedJsonObject(normalized))
  ]).filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || 'LLM response was not parseable JSON');
}

function stripMarkdownJsonFence(content) {
  return content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractBalancedJsonObject(content) {
  const text = String(content || '');
  const start = text.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return text.slice(start);
}

function repairLooseJson(content) {
  return String(content || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function buildLlmRepairPrompt(job, rawContent, error) {
  return JSON.stringify(
    {
      task: 'Repair the malformed analysis into valid JSON matching the required shape. If a value is missing, infer a conservative value from the job.',
      parseError: error instanceof Error ? error.message : String(error),
      requiredShape: {
        status: 'easy|needs_info|hard|not_fit',
        score: '0-100 integer',
        summary: 'short Cantonese internal paragraph',
        aiCanDo: ['short Cantonese strings'],
        humanNeeds: ['short Cantonese strings'],
        missingInfo: ['short Cantonese strings'],
        risks: ['short Cantonese strings'],
        recommendedNextStep: 'draft_apply_email|ask_for_details|manual_review|skip',
        pricingHint: 'short Cantonese string',
        quoteRecommendation: {
          canQuote: 'boolean',
          range: 'HKD range',
          quoteLine: 'short Cantonese quote/question sentence',
          assumptions: ['short Cantonese strings'],
          confidence: 'low|medium|high'
        },
        executionPlan: ['3-5 short Cantonese strings']
      },
      job: {
        id: job.id,
        title: job.title,
        categoryName: job.categoryName,
        budget: job.budget,
        detail: sanitizeForLlm(truncateForLlm(job.detail, 5000))
      },
      malformedContent: sanitizeForLlm(String(rawContent || '').slice(0, 12000)),
      outputRules: [
        'Return exactly one valid JSON object.',
        'No markdown.',
        'No comments.',
        'No trailing commas.'
      ]
    },
    null,
    2
  );
}

async function callChatCompletion(endpoint, payload, config) {
  const response = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'HTTP-Referer': 'http://127.0.0.1:4174',
      'X-Title': 'Freehunter AI Job Dashboard'
    },
    body: JSON.stringify(payload),
    timeoutMs: LLM_REQUEST_TIMEOUT_MS
  });

  const content = response?.choices?.[0]?.message?.content || '';
  return {
    content,
    usage: {
      inputTokens: response?.usage?.prompt_tokens || estimateTokens(JSON.stringify(payload.messages || [])),
      outputTokens: response?.usage?.completion_tokens || estimateTokens(content),
      actualUsd: Number(response?.usage?.cost || response?.usage?.total_cost || response?.usage?.estimated_cost || 0),
      attempts: 1
    }
  };
}

function addUsage(total, usage = {}) {
  total.inputTokens += Number(usage.inputTokens || 0);
  total.outputTokens += Number(usage.outputTokens || 0);
  total.actualUsd += Number(usage.actualUsd || 0);
  total.attempts += Number(usage.attempts || 0);
}

function costFromUsage(usage, config) {
  const pricing = modelPricing(config);
  return ((usage?.inputTokens || 0) / 1_000_000) * pricing.inputPerMillion
    + ((usage?.outputTokens || 0) / 1_000_000) * pricing.outputPerMillion;
}

function mockLlmReview(job) {
  const analysis = job.aiAnalysis || {};
  return {
    status: analysis.status,
    score: Math.min(100, Math.max(0, Number(analysis.score || 0) + (analysis.status === 'easy' ? 1 : 0))),
    summary: `${analysis.summary || ''}（mock reviewer 已覆核，等待接駁真 provider。）`,
    aiCanDo: analysis.aiCanDo || [],
    humanNeeds: analysis.humanNeeds || [],
    missingInfo: analysis.missingInfo || [],
    risks: analysis.risks || [],
    recommendedNextStep: analysis.recommendedNextStep,
    pricingHint: analysis.pricingHint,
    quoteRecommendation: analysis.quoteRecommendation,
    executionPlan: analysis.executionPlan || [],
    ...(LLM_REVIEW_MODE === 'analysis_and_draft' ? { emailDraft: analysis.emailDraft } : {}),
    usage: {
      inputTokens: estimateTokens(buildLlmPrompt(job, LLM_REVIEW_MODE)),
      outputTokens: LLM_REVIEW_MODE === 'analysis_only' ? 180 : 350,
      actualUsd: 0
    }
  };
}

function applyLlmReview(job, review, provider) {
  const status = ['easy', 'needs_info', 'hard', 'not_fit'].includes(review.status) ? review.status : job.aiAnalysis.status;
  const score = Number.isFinite(Number(review.score)) ? clamp(Math.round(Number(review.score)), 0, 100) : job.aiAnalysis.score;
  const nextStep = ['draft_apply_email', 'ask_for_details', 'manual_review', 'skip'].includes(review.recommendedNextStep)
    ? review.recommendedNextStep
    : chooseNextStep(status);

  job.aiAnalysis = {
    ...job.aiAnalysis,
    status,
    score,
    summary: stringValue(review.summary || job.aiAnalysis.summary),
    aiCanDo: Array.isArray(review.aiCanDo) ? review.aiCanDo.slice(0, 8) : job.aiAnalysis.aiCanDo,
    humanNeeds: Array.isArray(review.humanNeeds) ? review.humanNeeds.slice(0, 8) : job.aiAnalysis.humanNeeds,
    missingInfo: Array.isArray(review.missingInfo) ? review.missingInfo.slice(0, 8) : job.aiAnalysis.missingInfo,
    risks: Array.isArray(review.risks) ? review.risks.slice(0, 8) : job.aiAnalysis.risks,
    recommendedNextStep: nextStep,
    pricingHint: stringValue(review.pricingHint || job.aiAnalysis.pricingHint),
    quoteRecommendation: normalizeQuoteRecommendation(review.quoteRecommendation, job.aiAnalysis.quoteRecommendation),
    executionPlan: Array.isArray(review.executionPlan) ? review.executionPlan.slice(0, 8) : job.aiAnalysis.executionPlan,
    emailDraft: normalizeEmailDraft(review.emailDraft, status, job.aiAnalysis.emailDraft),
    llmReview: {
      provider,
      model: getLlmConfig().model,
      reviewMode: LLM_REVIEW_MODE,
      status: 'reviewed',
      schemaVersion: LLM_REVIEW_SCHEMA_VERSION,
      reviewedAt: new Date().toISOString()
    }
  };
}

function normalizeEmailDraft(draft, status, fallback) {
  if (!draft || typeof draft !== 'object') return fallback;
  const type = ['apply', 'clarify', 'follow_up', 'decline', 'skip'].includes(draft.type)
    ? draft.type
    : status === 'easy'
      ? 'apply'
      : status === 'needs_info'
        ? 'clarify'
        : status === 'not_fit'
          ? 'skip'
          : 'clarify';
  return {
    type,
    subject: stringValue(draft.subject || fallback?.subject).slice(0, 500),
    body: stringValue(draft.body || fallback?.body).slice(0, 10000)
  };
}

function normalizeQuoteRecommendation(quote, fallback = {}) {
  const source = quote && typeof quote === 'object' ? quote : fallback || {};
  return {
    canQuote: Boolean(source.canQuote),
    range: stringValue(source.range || fallback?.range).slice(0, 200),
    low: Number.isFinite(Number(source.low)) ? Number(source.low) : Number(fallback?.low || 0),
    high: Number.isFinite(Number(source.high)) ? Number(source.high) : Number(fallback?.high || 0),
    currency: stringValue(source.currency || fallback?.currency || 'HKD').slice(0, 20),
    confidence: ['low', 'medium', 'high'].includes(source.confidence) ? source.confidence : fallback?.confidence || 'low',
    basis: stringValue(source.basis || fallback?.basis).slice(0, 1000),
    assumptions: Array.isArray(source.assumptions) ? source.assumptions.map(stringValue).slice(0, 8) : fallback?.assumptions || [],
    quoteLine: stringValue(source.quoteLine || fallback?.quoteLine || source.range || fallback?.range).slice(0, 1000)
  };
}

function estimateLlmCost(job, config) {
  const inputTokens = estimateTokens(buildLlmPrompt(job, LLM_REVIEW_MODE));
  const outputTokens = LLM_REVIEW_MODE === 'analysis_only' ? 350 : 700;
  const pricing = modelPricing(config);
  return (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}

function modelPricing(config) {
  const envInput = Number(process.env.LLM_INPUT_USD_PER_1M || 0);
  const envOutput = Number(process.env.LLM_OUTPUT_USD_PER_1M || 0);
  if (envInput || envOutput) {
    return {
      inputPerMillion: envInput,
      outputPerMillion: envOutput
    };
  }

  const model = String(config.model || '').toLowerCase();
  if (model.includes('deepseek-v4-flash')) return { inputPerMillion: 0.0983, outputPerMillion: 0.1966 };
  if (model.includes('gpt-5-mini')) return { inputPerMillion: 0.25, outputPerMillion: 2 };
  if (model.includes('5.5')) return { inputPerMillion: 5, outputPerMillion: 30 };
  if (model.includes('5.4-mini') || model.includes('5.4 mini')) return { inputPerMillion: 0.75, outputPerMillion: 4.5 };
  if (model.includes('5.4')) return { inputPerMillion: 2.5, outputPerMillion: 15 };
  if (config.provider === 'mock' || config.provider === 'rule') return { inputPerMillion: 0, outputPerMillion: 0 };
  return { inputPerMillion: 1, outputPerMillion: 5 };
}

function normalizeLlmReviewMode(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return ['analysis_only', 'analysis_and_draft'].includes(normalized) ? normalized : 'analysis_only';
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.6);
}

function usageTotal(store, range) {
  const now = new Date();
  const events = Array.isArray(store.llmUsage) ? store.llmUsage : [];
  return roundMoney(
    events
      .filter((event) => {
        const eventDate = new Date(event.at);
        if (Number.isNaN(eventDate.getTime())) return false;
        if (range === 'day') {
          return eventDate.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
        }
        return eventDate.getUTCFullYear() === now.getUTCFullYear() && eventDate.getUTCMonth() === now.getUTCMonth();
      })
      .reduce((sum, event) => sum + Number(event.actualUsd || event.estimatedUsd || 0), 0)
  );
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, 'public', normalized);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes.get(ext) || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function loadEnvFile(filePath) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Unable to read .env file: ${error.message}`);
    }
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function listen(port, attempts = 0) {
  const onError = (error) => {
    server.off('listening', onListening);

    if (error.code === 'EADDRINUSE' && !process.env.PORT && attempts < 10) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use. Trying ${nextPort}...`);
      listen(nextPort, attempts + 1);
      return;
    }

    throw error;
  };

  const onListening = () => {
    server.off('error', onError);
    console.log(`Freehunter AI dashboard running at http://${HOST}:${port}`);
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}
