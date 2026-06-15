const state = {
  jobs: [],
  filteredJobs: [],
  selectedId: null,
  meta: null,
  runtime: null,
  filters: {
    query: '',
    status: 'all',
    category: 'all',
    duration: 'all',
    aiStatus: 'all',
    pipelineStatus: 'all',
    sort: 'aiScore',
    emailOnly: false,
    retainerOnly: false
  }
};

const els = {
  refreshButton: document.querySelector('#refreshButton'),
  exportCsvButton: document.querySelector('#exportCsvButton'),
  statusLine: document.querySelector('#statusLine'),
  searchInput: document.querySelector('#searchInput'),
  statusFilter: document.querySelector('#statusFilter'),
  categoryFilter: document.querySelector('#categoryFilter'),
  durationFilter: document.querySelector('#durationFilter'),
  aiStatusFilter: document.querySelector('#aiStatusFilter'),
  pipelineStatusFilter: document.querySelector('#pipelineStatusFilter'),
  sortSelect: document.querySelector('#sortSelect'),
  emailOnlyFilter: document.querySelector('#emailOnlyFilter'),
  retainerOnlyFilter: document.querySelector('#retainerOnlyFilter'),
  jobList: document.querySelector('#jobList'),
  jobDetail: document.querySelector('#jobDetail'),
  visibleCount: document.querySelector('#visibleCount'),
  metricJobs: document.querySelector('#metricJobs'),
  metricEmails: document.querySelector('#metricEmails'),
  metricApprovalQueue: document.querySelector('#metricApprovalQueue'),
  metricLlmPending: document.querySelector('#metricLlmPending'),
  metricApproved: document.querySelector('#metricApproved'),
  metricLatest: document.querySelector('#metricLatest'),
  opsLine: document.querySelector('#opsLine')
};

const durationLabels = {
  within_three_days: '3日內',
  within_one_month: '1個月內',
  one_to_three_month: '1至3個月',
  more_than_three_month: '3個月以上'
};

const statusLabels = {
  approved: 'Approved',
  pending: 'Pending',
  finished: 'Finished'
};

const aiStatusLabels = {
  easy: '容易',
  needs_info: '欠缺資料',
  hard: '較困難',
  not_fit: 'AI 做唔到'
};

const nextStepLabels = {
  draft_apply_email: '可草擬報價/聯絡',
  ask_for_details: '先追資料',
  manual_review: '人手先睇',
  skip: '暫時跳過'
};

const pipelineStatusLabels = {
  new: '新 job',
  shortlisted: '候選',
  needs_info: '要追資料',
  drafted: '已草擬',
  approved: '已 approve',
  sent: '已 sent',
  replied: '有回覆',
  won: '接到',
  lost: '無中',
  archived: '封存'
};

const projectStatusLabels = {
  not_started: '未開 project',
  briefing: '整理需求',
  waiting_client: '等客補資料',
  ready_for_worker: '可派 worker',
  in_progress: '製作中',
  needs_human: '等人手',
  ready_to_deliver: '可交付',
  delivered: '已交付',
  paused: '暫停'
};

const dateFormatter = new Intl.DateTimeFormat('zh-HK', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Hong_Kong'
});

init();

function init() {
  els.refreshButton.addEventListener('click', () => loadJobs(true));
  els.exportCsvButton.addEventListener('click', exportCsv);
  els.searchInput.addEventListener('input', (event) => {
    state.filters.query = event.target.value.trim();
    applyFilters();
  });
  els.statusFilter.addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    applyFilters();
  });
  els.categoryFilter.addEventListener('change', (event) => {
    state.filters.category = event.target.value;
    applyFilters();
  });
  els.durationFilter.addEventListener('change', (event) => {
    state.filters.duration = event.target.value;
    applyFilters();
  });
  els.aiStatusFilter.addEventListener('change', (event) => {
    state.filters.aiStatus = event.target.value;
    applyFilters();
  });
  els.pipelineStatusFilter.addEventListener('change', (event) => {
    state.filters.pipelineStatus = event.target.value;
    applyFilters();
  });
  els.sortSelect.addEventListener('change', (event) => {
    state.filters.sort = event.target.value;
    applyFilters();
  });
  els.emailOnlyFilter.addEventListener('change', (event) => {
    state.filters.emailOnly = event.target.checked;
    applyFilters();
  });
  els.retainerOnlyFilter.addEventListener('change', (event) => {
    state.filters.retainerOnly = event.target.checked;
    applyFilters();
  });

  loadRuntimeInfo();
  loadJobs(false);
}

async function loadRuntimeInfo() {
  try {
    const response = await fetch('/api/health');
    const payload = await response.json();
    state.runtime = payload;
    const llm = payload.llm || {};
    const hermes = payload.hermes || {};
    const store = payload.store || {};
    els.opsLine.textContent = [
      `Dashboard ${window.location.origin}`,
      'Start: npm start',
      `Store: ${store.provider || 'file'}${store.persistent === false ? ' (temporary)' : ''}`,
      store.path ? `Path: ${store.path}` : '',
      `Projects: ${payload.projectsDir || './projects'}`,
      `LLM: ${llm.provider || '-'} / ${llm.model || '-'}`,
      `Hermes: ${hermes.mode || 'file'}${hermes.webhookConfigured ? ' + webhook' : ' outbox'}`,
      `Outbox: ${hermes.outboxDir || 'data/hermes-outbox'}`,
      'Email send: not configured'
    ].filter(Boolean).join(' · ');
  } catch {
    els.opsLine.textContent = `Dashboard ${window.location.origin} · Start: npm start · Store: data/store.json`;
  }
}

async function loadJobs(forceRefresh) {
  setLoading(true, forceRefresh ? 'Refreshing latest jobs and client emails...' : 'Loading latest 30 days of Freehunter jobs and client emails...');

  try {
    const response = await fetch(`/api/jobs${forceRefresh ? '?refresh=1' : '?llmLimit=0'}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || payload.error || 'Failed to load jobs');
    }

    state.jobs = Array.isArray(payload.result) ? payload.result : [];
    state.meta = payload.meta || null;
    state.selectedId = state.jobs[0]?.id ?? null;
    populateFilters();
    applyFilters();
    renderMetrics();
    const cached = state.meta?.cached ? 'cache' : 'live API';
    const windowLabel = state.meta?.lookbackDays ? `latest ${state.meta.lookbackDays} days` : 'all time';
    const sourceCount = state.meta?.sourceCount ?? state.jobs.length;
    const since = state.meta?.includedSince ? ` since ${formatIsoDate(state.meta.includedSince)}` : '';
    const llm = state.meta?.llm || {};
    setStatus(
      `Loaded ${state.jobs.length.toLocaleString()} ${windowLabel} jobs${since} from ${sourceCount.toLocaleString()} total API rows via ${cached}. Emails found for ${state.meta?.emailsFound?.toLocaleString() || 0} job rows. LLM reviewed ${Number(llm.reviewed || 0).toLocaleString()}, reused ${Number(llm.reused || 0).toLocaleString()}, pending ${Number(llm.pendingReview || 0).toLocaleString()}.`
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setLoading(false);
  }
}

function populateFilters() {
  setOptions(els.statusFilter, uniqueValues(state.jobs, 'status'), 'All status', statusLabels);
  setOptions(els.categoryFilter, uniqueValues(state.jobs, 'categoryName'), 'All categories');
  setOptions(els.durationFilter, uniqueValues(state.jobs, 'duration'), 'All durations', durationLabels);
  setOptions(els.aiStatusFilter, Object.keys(aiStatusLabels), 'All AI fit', aiStatusLabels);
  setOptions(els.pipelineStatusFilter, Object.keys(pipelineStatusLabels), 'All pipeline', pipelineStatusLabels);
}

function setOptions(select, values, allLabel, labels = {}) {
  const current = select.value || 'all';
  select.innerHTML = [
    `<option value="all">${escapeHtml(allLabel)}</option>`,
    ...values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(labels[value] || value || 'Unknown')}</option>`)
  ].join('');
  select.value = values.includes(current) ? current : 'all';
}

function uniqueValues(items, key) {
  return [...new Set(items.map((item) => item[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hant'));
}

function applyFilters() {
  const query = state.filters.query.toLowerCase();
  let jobs = state.jobs.filter((job) => {
    if (state.filters.status !== 'all' && job.status !== state.filters.status) return false;
    if (state.filters.category !== 'all' && job.categoryName !== state.filters.category) return false;
    if (state.filters.duration !== 'all' && job.duration !== state.filters.duration) return false;
    if (state.filters.aiStatus !== 'all' && job.aiAnalysis?.status !== state.filters.aiStatus) return false;
    if (state.filters.pipelineStatus !== 'all' && job.workflow?.pipelineStatus !== state.filters.pipelineStatus) return false;
    if (state.filters.emailOnly && !job.clientEmail) return false;
    if (state.filters.retainerOnly && !retainerOpportunity(job).isCandidate) return false;
    if (!query) return true;

    const retainer = retainerOpportunity(job);
    const haystack = [
      job.title,
      job.detail,
      job.hideDetail,
      job.clientName,
      job.clientEmail,
      job.categoryName,
      job.status,
      job.budget,
      job.location,
      job.posterLocation,
      job.aiAnalysis?.summary,
      job.aiAnalysis?.status,
      aiStatusLabels[job.aiAnalysis?.status],
      job.workflow?.pipelineStatus,
      pipelineStatusLabels[job.workflow?.pipelineStatus],
      retainer.label,
      retainer.summary,
      job.workflow?.notes,
      job.workflow?.manualPrice,
      ...(job.aiAnalysis?.aiCanDo || []),
      ...(job.aiAnalysis?.missingInfo || []),
      ...(job.aiAnalysis?.risks || []),
      ...(job.skills || [])
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });

  jobs = sortJobs(jobs, state.filters.sort);
  state.filteredJobs = jobs;

  if (!jobs.some((job) => job.id === state.selectedId)) {
    state.selectedId = jobs[0]?.id ?? null;
  }

  renderJobList();
  renderDetail();
}

function sortJobs(jobs, sortBy) {
  const copy = [...jobs];
  const sorters = {
    aiScore: (a, b) => (b.aiAnalysis?.score || 0) - (a.aiAnalysis?.score || 0) || b.createdAtSeconds - a.createdAtSeconds,
    newest: (a, b) => b.createdAtSeconds - a.createdAtSeconds || b.id - a.id,
    modified: (a, b) => b.latestModifySeconds - a.latestModifySeconds || b.createdAtSeconds - a.createdAtSeconds,
    budget: (a, b) => budgetRank(b.budget) - budgetRank(a.budget) || b.createdAtSeconds - a.createdAtSeconds,
    email: (a, b) => Number(Boolean(b.clientEmail)) - Number(Boolean(a.clientEmail)) || b.createdAtSeconds - a.createdAtSeconds
  };
  return copy.sort(sorters[sortBy] || sorters.newest);
}

function renderMetrics() {
  const easy = state.jobs.filter((job) => job.aiAnalysis?.status === 'easy').length;
  const approvalQueue = state.jobs.filter((job) =>
    ['shortlisted', 'needs_info', 'drafted'].includes(job.workflow?.pipelineStatus)
  ).length;
  const latestSeconds = state.jobs.reduce((max, job) => Math.max(max, job.createdAtSeconds || 0), 0);

  els.metricJobs.textContent = state.jobs.length.toLocaleString();
  els.metricEmails.textContent = `${state.meta?.emailsFound?.toLocaleString() || 0}`;
  els.metricApprovalQueue.textContent = approvalQueue.toLocaleString();
  els.metricLlmPending.textContent = Number(state.meta?.llm?.pendingReview || 0).toLocaleString();
  els.metricApproved.textContent = easy.toLocaleString();
  els.metricLatest.textContent = latestSeconds ? formatDate(latestSeconds) : '-';
}

function renderJobList() {
  els.visibleCount.textContent = `${state.filteredJobs.length.toLocaleString()} shown`;

  if (!state.filteredJobs.length) {
    els.jobList.innerHTML = '<div class="empty-state"><p>No jobs match the current filters.</p></div>';
    return;
  }

  els.jobList.innerHTML = state.filteredJobs
    .map((job) => {
      const active = job.id === state.selectedId ? ' active' : '';
      const statusClass = `status-${slug(job.status)}`;
      const emailClass = job.clientEmail ? 'email-ok' : job.emailStatus === 'error' ? 'email-error' : '';
      const aiStatus = job.aiAnalysis?.status || 'not_fit';
      const aiScore = job.aiAnalysis?.score ?? 0;
      const pipelineStatus = job.workflow?.pipelineStatus || 'new';
      const retainer = retainerOpportunity(job);
      return `
        <button class="job-card${active}" type="button" data-id="${job.id}">
          <div class="job-card-top">
            <h3 class="job-card-title">${escapeHtml(job.title)}</h3>
            <span class="job-id">#${escapeHtml(String(job.id))}</span>
          </div>
          <div class="job-card-meta">
            ${tag(statusLabels[job.status] || job.status || 'Unknown', statusClass)}
            ${tag(`${aiStatusLabels[aiStatus] || aiStatus} · ${aiScore}`, `ai-${slug(aiStatus)}`)}
            ${tag(pipelineStatusLabels[pipelineStatus] || pipelineStatus, `pipe-${slug(pipelineStatus)}`)}
            ${retainer.isCandidate ? tag('AI retainer exp', 'retainer-tag') : ''}
            ${tag(job.categoryName || 'No category')}
            ${tag(job.budget || 'No budget')}
            ${job.boostStatus ? tag('Boosted', 'status-approved') : ''}
          </div>
          <div class="scorebar" aria-hidden="true"><span style="width: ${Math.max(4, Math.min(100, aiScore))}%"></span></div>
          <p class="job-card-summary">${escapeHtml(job.detail || job.hideDetail || 'No detail supplied.')}</p>
          <div class="client-line">
            <span>${escapeHtml(job.clientName || `Client ${job.clientId || '-'}`)}</span>
            <span class="email-text ${emailClass}">${escapeHtml(job.clientEmail || 'Email not found')}</span>
          </div>
        </button>
      `;
    })
    .join('');

  els.jobList.querySelectorAll('.job-card').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedId = Number(button.dataset.id);
      renderJobList();
      renderDetail();
    });
  });
}

function renderDetail() {
  const job = state.filteredJobs.find((item) => item.id === state.selectedId);

  if (!job) {
    els.jobDetail.className = 'empty-detail';
    els.jobDetail.innerHTML = '<p>Select a job to inspect the full brief, company notes, and client email.</p>';
    return;
  }

  const analysis = job.aiAnalysis || {};
  const workflow = job.workflow || {};
  const project = workflow.project || {};
  const draft = workflow.draft || analysis.emailDraft || {};
  const pipelineStatus = workflow.pipelineStatus || 'new';
  const projectStatus = project.projectStatus || 'not_started';
  const source = analysisSource(analysis);
  const quote = analysis.quoteRecommendation || {};
  const executionPlan = Array.isArray(analysis.executionPlan) ? analysis.executionPlan : [];
  const retainer = retainerOpportunity(job);

  els.jobDetail.className = 'detail-inner';
  els.jobDetail.innerHTML = `
    <div class="detail-title-row">
      <div>
        <div class="detail-meta">
          ${tag(`#${job.id}`)}
          ${tag(statusLabels[job.status] || job.status || 'Unknown', `status-${slug(job.status)}`)}
          ${tag(`${aiStatusLabels[analysis.status] || analysis.status || 'AI fit'} · ${analysis.score ?? 0}`, `ai-${slug(analysis.status)}`)}
          ${tag(source.label, source.className)}
          ${tag(pipelineStatusLabels[pipelineStatus] || pipelineStatus, `pipe-${slug(pipelineStatus)}`)}
          ${retainer.isCandidate ? tag('AI retainer exp', 'retainer-tag') : ''}
          ${job.directApply ? tag('Direct apply', 'email-ok') : ''}
        </div>
        <h2>${escapeHtml(job.title)}</h2>
      </div>
      <div class="detail-actions">
        <button class="button ghost" id="copyBriefButton" type="button">Copy brief</button>
      </div>
    </div>

    <div class="workflow-panel">
      <div>
        <span>Pipeline status</span>
        <select id="workflowStatusSelect">
          ${Object.entries(pipelineStatusLabels)
            .map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === pipelineStatus ? 'selected' : ''}>${escapeHtml(label)}</option>`)
            .join('')}
        </select>
      </div>
      <div>
        <span>Price / quote note</span>
        <input id="manualPriceInput" type="text" value="${escapeAttr(workflow.manualPrice || '')}" placeholder="例：HKD 8,000 起 / 先問 scope" />
      </div>
      <label class="workflow-notes">
        <span>Internal notes</span>
        <textarea id="notesInput" rows="3" placeholder="人手判斷、客戶偏好、下一步...">${escapeHtml(workflow.notes || '')}</textarea>
      </label>
      <div class="workflow-actions">
        <button class="button ghost" id="saveWorkflowButton" type="button">Save status</button>
        <button class="button secondary" id="approveDraftButton" type="button" ${draft.body ? '' : 'disabled'}>Approve draft</button>
      </div>
      <p class="guardrail">Approve 只會記錄本地狀態，唔會 send email。</p>
    </div>

    <div class="client-box">
      <div>
        <span>Client email</span>
        ${
          job.clientEmail
            ? `<a href="mailto:${escapeAttr(job.clientEmail)}">${escapeHtml(job.clientEmail)}</a>`
            : `<strong>${escapeHtml(job.emailError || 'Email not found')}</strong>`
        }
      </div>
      <button class="button ghost" id="copyEmailButton" type="button" ${job.clientEmail ? '' : 'disabled'}>Copy email</button>
    </div>

    <div class="detail-grid">
      ${fact('AI Fit', `${aiStatusLabels[analysis.status] || '-'} · ${analysis.score ?? 0}/100`)}
      ${fact('Score Source', source.detail)}
      ${fact('Next Step', nextStepLabels[analysis.recommendedNextStep] || '-')}
      ${fact('Pricing', analysis.pricingHint || '-')}
      ${fact('Client', `${job.clientName || '-'}${job.clientId ? ` · ID ${job.clientId}` : ''}`)}
      ${fact('Budget', job.budget || '-')}
      ${fact('Category', job.categoryName || '-')}
      ${fact('Duration', durationLabels[job.duration] || job.duration || '-')}
      ${fact('Location', [job.location, job.posterLocation].filter(Boolean).join(' · ') || '-')}
      ${fact('Created', `${formatDate(job.createdAtSeconds)}${job.createdAtText ? ` · ${job.createdAtText}` : ''}`)}
    </div>

    <div class="analysis-panel ai-${escapeAttr(slug(analysis.status))}">
      <div class="analysis-score">
        <span>${escapeHtml(aiStatusLabels[analysis.status] || 'AI Fit')}</span>
        <strong>${escapeHtml(String(analysis.score ?? 0))}</strong>
      </div>
      <p>${escapeHtml(analysis.summary || '未有分析。')}</p>
    </div>

    <div class="detail-section quote-panel">
      <div class="section-title-row">
        <h3>報價建議</h3>
        ${tag(quote.canQuote ? '可初步報價' : '先追資料', quote.canQuote ? 'quote-ready' : 'quote-clarify')}
      </div>
      <p><strong>${escapeHtml(quote.quoteLine || quote.range || '暫時未有報價建議。')}</strong></p>
      ${quote.basis ? `<p>${escapeHtml(quote.basis)}</p>` : ''}
      ${miniList('報價假設', quote.assumptions)}
      ${miniList('執行方法', executionPlan)}
    </div>

    ${
      retainer.isCandidate
        ? `<div class="detail-section retainer-panel">
            <div class="section-title-row">
              <h3>AI retainer experiment</h3>
              ${tag(retainer.level, 'retainer-tag')}
            </div>
            <p>${escapeHtml(retainer.summary)}</p>
            ${miniList('包裝成服務包', retainer.packageTerms)}
            ${miniList('唔好承諾', retainer.guardrails)}
          </div>`
        : ''
    }

    <div class="detail-section analysis-grid">
      ${miniList('AI 可以做', analysis.aiCanDo)}
      ${miniList('人手要做', analysis.humanNeeds)}
      ${miniList('要追資料', analysis.missingInfo)}
      ${miniList('風險', analysis.risks)}
    </div>

    <div class="detail-section project-os">
      <div class="section-title-row">
        <div>
          <h3>Project OS</h3>
          <p class="quiet">每個 job 自己一個 workspace、對話、task plan 同 worker prompt。</p>
        </div>
        <div class="draft-actions">
          <button class="button secondary" id="createProjectButton" type="button">${project.folderPath ? 'Sync workspace' : 'Create project'}</button>
          <button class="button ghost" id="saveProjectButton" type="button">Save project</button>
          <button class="button ghost" id="copyWorkerPromptButton" type="button">Copy worker prompt</button>
        </div>
      </div>
      <div class="project-summary">
        ${tag(projectStatusLabels[projectStatus] || projectStatus, `project-${slug(projectStatus)}`)}
        ${project.folderPath ? `<code>${escapeHtml(project.folderPath)}</code>` : '<span class="quiet">未建立本地 project folder</span>'}
      </div>
      <div class="hermes-handoff-box">
        <div>
          <h4>Hermes manager handoff</h4>
          <p>${escapeHtml(hermesHandoffSummary(project))}</p>
          ${renderHermesHandoffMeta(project)}
        </div>
        <div class="handoff-actions">
          <button class="button primary" id="passHermesButton" type="button">${project.hermesHandoff?.status === 'cancelled' ? 'Pass again' : 'Pass to Hermes Agent'}</button>
          ${
            project.hermesHandoff?.status && project.hermesHandoff.status !== 'cancelled'
              ? '<button class="button danger" id="cancelHermesButton" type="button">Cancel Hermes</button>'
              : ''
          }
        </div>
      </div>
      <div class="project-grid">
        <label>
          <span>Project status</span>
          <select id="projectStatusSelect">
            ${Object.entries(projectStatusLabels)
              .map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === projectStatus ? 'selected' : ''}>${escapeHtml(label)}</option>`)
              .join('')}
          </select>
        </label>
        <label>
          <span>Manager notes</span>
          <textarea id="projectManagerNotesInput" rows="4" placeholder="你對呢個 project 嘅判斷、報價方向、交付策略...">${escapeHtml(project.managerNotes || '')}</textarea>
        </label>
      </div>
      <label class="project-field">
        <span>Client conversation</span>
        <textarea id="conversationInput" rows="7" placeholder="將你同客戶嘅對話貼喺度，manager 之後可以基於呢度判斷下一步。">${escapeHtml(project.conversation || '')}</textarea>
      </label>
      <label class="project-field">
        <span>Task plan</span>
        <textarea id="taskPlanInput" rows="8" placeholder="- [ ] 問清楚 scope&#10;- [ ] 做第一版草稿&#10;- [ ] 人手 approve 後先 send">${escapeHtml(project.taskPlan || buildDefaultTaskPlan(job))}</textarea>
      </label>
      <label class="project-field">
        <span>Deliverables note</span>
        <textarea id="deliverablesNoteInput" rows="4" placeholder="交付檔案、版本、連結、檢查事項...">${escapeHtml(project.deliverablesNote || '')}</textarea>
      </label>
      <details class="worker-prompt-box">
        <summary>Worker prompt preview</summary>
        <pre>${escapeHtml(project.workerPrompt || buildWorkerPrompt(job))}</pre>
      </details>
    </div>

    <div class="detail-section">
      <div class="section-title-row">
        <h3>廣東話 email draft</h3>
        <div class="draft-actions">
          <button class="button ghost" id="saveDraftButton" type="button" ${draft.body ? '' : 'disabled'}>Save edit</button>
          <button class="button ghost" id="copyDraftButton" type="button" ${draft.body ? '' : 'disabled'}>Copy draft</button>
        </div>
      </div>
      ${
        draft.body
          ? `<div class="email-draft">
              <span>Subject</span>
              <input id="draftSubjectInput" type="text" value="${escapeAttr(draft.subject)}" />
              <span>Body</span>
              <textarea id="draftBodyInput" rows="12">${escapeHtml(draft.body)}</textarea>
              <p class="draft-meta">Draft status: ${escapeHtml(draft.status || 'generated')} · Source: ${escapeHtml(draft.source || 'rule')}</p>
            </div>`
          : '<p class="quiet">呢類 job 暫時唔建議主動聯絡。</p>'
      }
    </div>

    <div class="detail-section communication-panel">
      <div class="section-title-row">
        <div>
          <h3>Conversation log</h3>
          <p class="quiet">Email、WhatsApp、Freehunter 回覆同 agent note 全部記喺度。</p>
        </div>
        ${tag(`${workflow.eventCount || 0} events`)}
      </div>
      <div class="communication-form">
        <select id="communicationChannelSelect">
          <option value="email">Email</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="freehunter">Freehunter</option>
          <option value="agent_note">Agent note</option>
          <option value="other">Other</option>
        </select>
        <select id="communicationDirectionSelect">
          <option value="outbound">Outbound</option>
          <option value="inbound">Inbound</option>
          <option value="internal">Internal</option>
        </select>
        <input id="communicationSubjectInput" type="text" placeholder="Subject / short label" />
        <button class="button ghost" id="logCommunicationButton" type="button">Log</button>
        <textarea id="communicationBodyInput" rows="4" placeholder="貼上已 send 嘅 email、客人回覆、WhatsApp 對話，或者 agent note..."></textarea>
      </div>
      ${renderCommunicationTimeline(workflow.events)}
    </div>

    <div class="detail-section">
      <h3>Skills</h3>
      <div class="detail-meta">
        ${(job.skills || []).map((skill) => tag(skill)).join('') || tag('No skills listed')}
      </div>
    </div>

    <div class="detail-section">
      <h3>Job detail</h3>
      <p>${formatRichText(job.detail || 'No detail supplied.')}</p>
    </div>

    <div class="detail-section">
      <h3>Client or company notes</h3>
      <p>${formatRichText(job.hideDetail || 'No hidden detail supplied.')}</p>
    </div>

    <div class="detail-section">
      <h3>Raw job payload</h3>
      <pre class="raw-json">${escapeHtml(JSON.stringify(job.raw, null, 2))}</pre>
    </div>
  `;

  document.querySelector('#copyEmailButton')?.addEventListener('click', () => copyText(job.clientEmail, 'Email copied.'));
  document.querySelector('#copyBriefButton')?.addEventListener('click', () => copyText(buildBrief(job), 'Brief copied.'));
  document.querySelector('#copyDraftButton')?.addEventListener('click', () => copyDraft(job));
  document.querySelector('#saveDraftButton')?.addEventListener('click', () => saveDraft(job));
  document.querySelector('#saveWorkflowButton')?.addEventListener('click', () => saveWorkflow(job));
  document.querySelector('#approveDraftButton')?.addEventListener('click', () => approveDraft(job));
  document.querySelector('#createProjectButton')?.addEventListener('click', () => saveProject(job, true));
  document.querySelector('#saveProjectButton')?.addEventListener('click', () => saveProject(job, false));
  document.querySelector('#copyWorkerPromptButton')?.addEventListener('click', () => copyText(buildWorkerPromptFromDom(job), 'Worker prompt copied.'));
  document.querySelector('#passHermesButton')?.addEventListener('click', () => passToHermes(job));
  document.querySelector('#cancelHermesButton')?.addEventListener('click', () => cancelHermes(job));
  document.querySelector('#logCommunicationButton')?.addEventListener('click', () => logCommunication(job));
}

function fact(label, value) {
  return `
    <div class="fact">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function tag(label, className = '') {
  if (!label) return '';
  return `<span class="tag ${escapeAttr(className)}">${escapeHtml(label)}</span>`;
}

function miniList(title, items = []) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return `
    <article class="mini-list">
      <h3>${escapeHtml(title)}</h3>
      ${
        list.length
          ? `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
          : '<p class="quiet">暫時無。</p>'
      }
    </article>
  `;
}

function renderCommunicationTimeline(events = []) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    return '<div class="timeline empty-timeline"><p class="quiet">未有對話記錄。Approve、copy draft、send/WhatsApp 記錄之後會出喺度。</p></div>';
  }

  return `
    <div class="timeline">
      ${list.map((event) => `
        <article class="timeline-item">
          <div class="timeline-head">
            ${tag(eventLabel(event), `event-${slug(event.direction || event.type)}`)}
            <span>${escapeHtml(formatIsoDate(event.at))}</span>
          </div>
          ${event.subject ? `<strong>${escapeHtml(event.subject)}</strong>` : ''}
          <p>${formatRichText(event.body || event.message || '-')}</p>
          ${event.actor ? `<small>${escapeHtml(event.actor)}</small>` : ''}
        </article>
      `).join('')}
    </div>
  `;
}

function hermesHandoffSummary(project = {}) {
  const hermes = state.runtime?.hermes || {};
  if (project.hermesHandoff?.status === 'cancelled') {
    return `已取消 handoff。Hermes 應停止處理；原因：${project.hermesHandoff.cancelReason || '未有補充原因'}`;
  }
  if (project.hermesHandoff?.status === 'ready') {
    return '已產生 handoff。Hermes 可以讀 outbox / webhook payload，然後管理跟進、整合問題同派工俾 Codex。';
  }
  if (hermes.webhookConfigured) {
    return '會同步 project workspace，寫入 handoff 檔案，並 POST 到 Hermes webhook。';
  }
  return '會同步 project workspace，寫入 Hermes outbox。之後 Hermes portal 可以 watch 呢個 folder 或你手動匯入。';
}

function renderHermesHandoffMeta(project = {}) {
  const meta = project.hermesHandoff || {};
  const hermes = state.runtime?.hermes || {};
  const rows = [
    ['Status', meta.status || '-'],
    ['Mode', meta.mode || hermes.mode || 'file'],
    ['Outbox', meta.outboxPath || hermes.outboxDir || 'data/hermes-outbox'],
    ['Webhook', meta.webhookStatus || (hermes.webhookConfigured ? 'configured' : 'not configured')],
    ['Updated', meta.updatedAt ? formatIsoDate(meta.updatedAt) : '-']
  ];

  return `
    <dl class="handoff-meta">
      ${rows.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

function eventLabel(event = {}) {
  const channel = {
    email: 'Email',
    whatsapp: 'WhatsApp',
    freehunter: 'Freehunter',
    phone: 'Phone',
    agent_note: 'Agent',
    other: 'Other'
  }[event.channel] || event.type || 'Event';
  const direction = {
    outbound: 'out',
    inbound: 'in',
    internal: 'note'
  }[event.direction] || '';
  return direction ? `${channel} · ${direction}` : channel;
}

function retainerOpportunity(job) {
  const analysis = job.aiAnalysis || {};
  const text = normalizeSearchText([
    job.title,
    job.detail,
    job.hideDetail,
    job.categoryName,
    job.duration,
    job.location,
    job.budget,
    ...(job.skills || [])
  ].join(' '));
  const score = Number(analysis.score || 0);
  const longTerm = textHasAny(text, [
    '長期合作',
    '長期',
    'part-time',
    'part time',
    'monthly',
    '月費',
    '每月',
    'ongoing',
    'retainer',
    'remote',
    'freelance'
  ]);
  const aiManaged = textHasAny(text, [
    'remote',
    'canva',
    'figma',
    'adobe',
    'seo',
    'social media',
    '社交媒體',
    'ig',
    'banner',
    'post',
    '網頁',
    'ui',
    '內容',
    '設計',
    '剪接'
  ]);
  const providerAd = looksLikeProviderAd(text);
  const contactable = job.status === 'approved' && Boolean(job.clientEmail) && analysis.status !== 'not_fit' && !providerAd;
  const isCandidate = contactable && longTerm && aiManaged && score >= 55;
  const level = score >= 82 ? 'strong experiment' : score >= 68 ? 'test carefully' : 'small trial';

  return {
    isCandidate,
    level,
    label: isCandidate ? 'AI retainer exp' : '',
    summary: isCandidate
      ? '適合實驗 AI 管理月費/長期服務：用固定交付件、固定回覆節奏同修改上限，避免變成無限 part-time 工作。'
      : providerAd
        ? '似 freelancer 自己賣服務嘅貼文，唔應該當客戶 lead。'
        : '',
    packageTerms: buildRetainerPackageTerms(job),
    guardrails: [
      '唔承諾固定工作時數，改成固定 deliverables / response window。',
      '唔作 portfolio、公司經驗或人手背景；作品集由 Jack 提供真實資料。',
      '唔包無限修改，先寫明每月修改次數同額外收費。',
      '涉及現場、拍攝、真人表演或專業牌照嘅部分，要另行確認人手。'
    ]
  };
}

function buildRetainerPackageTerms(job) {
  const text = normalizeSearchText([job.title, job.detail, job.categoryName, ...(job.skills || [])].join(' '));
  if (textHasAny(text, ['social media', '社交媒體', 'ig', 'post', 'story', 'reels'])) {
    return [
      '改寫成月費內容包：每月固定 post/story/reels 數量。',
      '廣告投放 budget 另計，只負責 setup、素材同報告。',
      '每月一次內容方向 brief，不做即時全天候客服。'
    ];
  }
  if (textHasAny(text, ['graphic', '平面', '設計', 'banner', '海報', '小冊子'])) {
    return [
      '改寫成設計 retainer：每月固定 KV/banner/post/print item 數量。',
      '每件包括一版初稿及指定修改次數。',
      '超出尺寸、急件、全新方向另行報價。'
    ];
  }
  if (textHasAny(text, ['ui', 'ux', '網頁', 'website', 'app'])) {
    return [
      '先拆成 discovery / wireframe / UI phase。',
      '月費只包指定頁面或 component 數量。',
      '前端開發、會員系統、付款、部署另行報價。'
    ];
  }
  return [
    '先定每月固定交付件同交付日。',
    '每月固定一次檢討同下一輪 brief。',
    '任何額外 scope 先報價再做。'
  ];
}

function looksLikeProviderAd(text) {
  const providerSignals = textHasAny(text, ['我可以幫你', '收費參考', '想睇作品集', '有 project', 'whatsapp', '期待同你合作']);
  const clientSignals = textHasAny(text, ['we are looking', '我們正在尋找', '招聘', '聘請', '需要一位', 'responsibilities', 'requirements']);
  return providerSignals && !clientSignals;
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase();
}

function textHasAny(text, needles) {
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

function analysisSource(analysis = {}) {
  const review = analysis.llmReview || {};
  if (review.status === 'reviewed') {
    return {
      label: `${review.provider || 'LLM'} reviewed`,
      detail: `${review.provider || 'LLM'} · ${review.model || '-'} · ${review.reviewedAt ? formatIsoDate(review.reviewedAt) : 'reviewed'}`,
      className: 'source-reviewed'
    };
  }

  if (review.status === 'error') {
    return {
      label: `${review.provider || 'LLM'} error`,
      detail: `${review.provider || 'LLM'} failed, using local rule score`,
      className: 'source-error'
    };
  }

  if (review.status === 'skipped') {
    return {
      label: 'Rule score',
      detail: `Local rule score · ${review.reason || 'LLM not used'}`,
      className: 'source-rule'
    };
  }

  return {
    label: 'Rule score',
    detail: 'Local rule score, not yet LLM-reviewed',
    className: 'source-rule'
  };
}

function setLoading(isLoading, message = '') {
  els.refreshButton.disabled = isLoading;
  els.exportCsvButton.disabled = isLoading || !state.filteredJobs.length;
  if (message) setStatus(message);
}

function setStatus(message, isError = false) {
  els.statusLine.textContent = message;
  els.statusLine.classList.toggle('error', isError);
}

function formatDate(seconds) {
  if (!seconds) return '-';
  return dateFormatter.format(new Date(seconds * 1000));
}

function formatIsoDate(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '-';
  return dateFormatter.format(date);
}

function formatRichText(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${url}</a>`)
    .replace(/\n/g, '<br />');
}

function budgetRank(budget) {
  const numbers = String(budget || '')
    .replace(/,/g, '')
    .match(/\d+/g)
    ?.map(Number);
  return numbers?.length ? Math.max(...numbers) : 0;
}

async function copyText(text, successMessage) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(successMessage);
  } catch {
    setStatus('Clipboard access failed. Select the text manually.', true);
  }
}

async function copyDraft(job) {
  const text = buildEmailDraftText(job);
  if (!text) return;
  await copyText(text, 'Email draft copied. No email was sent.');
  const payload = await postJson('/api/draft/copy', { jobId: job.id });
  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
  }
}

async function saveDraft(job) {
  const subject = document.querySelector('#draftSubjectInput')?.value || '';
  const body = document.querySelector('#draftBodyInput')?.value || '';
  const payload = await postJson('/api/draft', {
    jobId: job.id,
    subject,
    body,
    type: job.workflow?.draft?.type || job.aiAnalysis?.emailDraft?.type || 'clarify'
  });

  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    setStatus('Draft saved locally. No email was sent.');
  } else {
    setStatus(payload.message || 'Unable to save draft.', true);
  }
}

async function saveWorkflow(job) {
  const payload = await postJson('/api/job-state', {
    jobId: job.id,
    pipelineStatus: document.querySelector('#workflowStatusSelect')?.value || job.workflow?.pipelineStatus || 'new',
    manualPrice: document.querySelector('#manualPriceInput')?.value || '',
    notes: document.querySelector('#notesInput')?.value || ''
  });

  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    setStatus('Pipeline status saved locally.');
  } else {
    setStatus(payload.message || 'Unable to save status.', true);
  }
}

async function saveProject(job, createWorkspace) {
  const payload = await postJson('/api/project', buildProjectPayload(job, createWorkspace));

  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    setStatus(createWorkspace ? 'Project workspace synced locally.' : 'Project saved locally.');
  } else {
    setStatus(payload.message || 'Unable to save project.', true);
  }
}

async function passToHermes(job) {
  setStatus('Preparing Hermes handoff bundle...');
  const statusSelect = document.querySelector('#projectStatusSelect');
  const selectedStatus = statusSelect?.value || job.workflow?.project?.projectStatus || 'not_started';
  const payload = await postJson('/api/hermes/handoff', {
    ...buildProjectPayload(job, true),
    createWorkspace: true,
    syncFiles: true,
    projectStatus: selectedStatus === 'not_started' ? 'ready_for_worker' : selectedStatus
  });

  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    const handoff = payload.handoff || {};
    const where = handoff.outboxPath ? ` Outbox: ${handoff.outboxPath}` : '';
    const webhook = handoff.webhook ? ` Webhook: ${handoff.webhook.ok ? 'posted' : handoff.webhook.status || 'failed'}.` : '';
    setStatus(`Hermes handoff ready.${where}${webhook}`);
  } else {
    setStatus(payload.message || 'Unable to pass to Hermes.', true);
  }
}

async function cancelHermes(job) {
  const defaultReason = 'Not suitable after review; pause and do not process further.';
  const reason = window.prompt('Cancel Hermes handoff reason', job.workflow?.project?.hermesHandoff?.cancelReason || defaultReason);
  if (reason === null) return;

  setStatus('Cancelling Hermes handoff...');
  const payload = await postJson('/api/hermes/cancel', {
    ...buildProjectPayload(job, false),
    reason
  });

  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    const outbox = payload.cancel?.outboxPath ? ` Outbox: ${payload.cancel.outboxPath}` : '';
    setStatus(`Hermes handoff cancelled. Pipeline archived, project paused.${outbox}`);
  } else {
    setStatus(payload.message || 'Unable to cancel Hermes handoff.', true);
  }
}

async function approveDraft(job) {
  const subject = document.querySelector('#draftSubjectInput')?.value || job.workflow?.draft?.subject || '';
  const body = document.querySelector('#draftBodyInput')?.value || job.workflow?.draft?.body || '';
  if (subject || body) {
    const saved = await postJson('/api/draft', {
      jobId: job.id,
      subject,
      body,
      type: job.workflow?.draft?.type || job.aiAnalysis?.emailDraft?.type || 'clarify'
    });
    if (saved.ok && saved.opportunity) updateJobWorkflow(saved.opportunity, false);
  }

  const payload = await postJson('/api/draft/approve', { jobId: job.id });
  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    setStatus('Draft approved locally. No email was sent.');
  } else {
    setStatus(payload.message || 'Unable to approve draft.', true);
  }
}

async function logCommunication(job) {
  const channel = document.querySelector('#communicationChannelSelect')?.value || 'other';
  const direction = document.querySelector('#communicationDirectionSelect')?.value || 'internal';
  const subject = document.querySelector('#communicationSubjectInput')?.value || '';
  const body = document.querySelector('#communicationBodyInput')?.value || '';

  const payload = await postJson('/api/communication', {
    jobId: job.id,
    channel,
    direction,
    subject,
    body,
    actor: 'Jack Lo / manager'
  });

  if (payload.ok && payload.opportunity) {
    updateJobWorkflow(payload.opportunity);
    setStatus(direction === 'outbound' ? 'Outbound communication logged locally.' : 'Communication logged locally.');
  } else {
    setStatus(payload.message || 'Unable to log communication.', true);
  }
}

function buildProjectPayload(job, createWorkspace) {
  const hasWorkspace = Boolean(job.workflow?.project?.folderPath);
  return {
    jobId: job.id,
    createWorkspace,
    syncFiles: createWorkspace || hasWorkspace,
    projectStatus: document.querySelector('#projectStatusSelect')?.value || job.workflow?.project?.projectStatus || 'not_started',
    managerNotes: document.querySelector('#projectManagerNotesInput')?.value || '',
    conversation: document.querySelector('#conversationInput')?.value || '',
    taskPlan: document.querySelector('#taskPlanInput')?.value || '',
    deliverablesNote: document.querySelector('#deliverablesNoteInput')?.value || '',
    job: {
      id: job.id,
      title: job.title,
      detail: job.detail,
      hideDetail: job.hideDetail,
      clientName: job.clientName,
      clientEmail: job.clientEmail,
      clientId: job.clientId,
      categoryName: job.categoryName,
      skills: job.skills,
      budget: job.budget,
      duration: job.duration,
      location: job.location,
      aiAnalysis: job.aiAnalysis
    }
  };
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) {
      return { ok: false, message: payload.message || payload.error || `Request failed: ${response.status}` };
    }
    return payload;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function updateJobWorkflow(opportunity, rerender = true) {
  state.jobs = state.jobs.map((job) => (job.id === opportunity.jobId ? { ...job, workflow: opportunity } : job));
  state.filteredJobs = state.filteredJobs.map((job) => (job.id === opportunity.jobId ? { ...job, workflow: opportunity } : job));
  if (rerender) {
    applyFilters();
    renderMetrics();
  }
}

function buildBrief(job) {
  return [
    `Job: ${job.title}`,
    `ID: ${job.id}`,
    `Client: ${job.clientName || '-'} (${job.clientId || '-'})`,
    `Email: ${job.clientEmail || '-'}`,
    `Budget: ${job.budget || '-'}`,
    `Category: ${job.categoryName || '-'}`,
    `Skills: ${(job.skills || []).join(', ') || '-'}`,
    `AI Fit: ${aiStatusLabels[job.aiAnalysis?.status] || '-'} (${job.aiAnalysis?.score ?? '-'}/100)`,
    `AI Summary: ${job.aiAnalysis?.summary || '-'}`,
    '',
    job.detail || '',
    '',
    job.hideDetail || ''
  ].join('\n');
}

function buildDefaultTaskPlan(job) {
  const analysis = job.aiAnalysis || {};
  const tasks = [
    '- [ ] Confirm scope, deadline, budget, and acceptance criteria.',
    '- [ ] Draft a concise Cantonese client reply for human approval.',
    '- [ ] Prepare quote stance and delivery timeline.'
  ];

  if (Array.isArray(analysis.missingInfo)) {
    tasks.push(...analysis.missingInfo.slice(0, 4).map((item) => `- [ ] Ask client: ${item}`));
  }

  if (Array.isArray(analysis.aiCanDo)) {
    tasks.push(...analysis.aiCanDo.slice(0, 4).map((item) => `- [ ] Worker task: ${item}`));
  }

  tasks.push('- [ ] Human review before any external email or deliverable is sent.');
  return tasks.join('\n');
}

function buildWorkerPrompt(job) {
  const analysis = job.aiAnalysis || {};
  return [
    `You are a worker agent for Freehunter job #${job.id}.`,
    '',
    'Goal:',
    'Help prepare this freelance project for delivery. Work only inside this project folder unless explicitly instructed otherwise.',
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
    `Skills: ${(job.skills || []).join(', ') || '-'}`,
    '',
    'AI analysis:',
    `Fit: ${analysis.status || '-'} (${analysis.score || 0}/100)`,
    `Summary: ${analysis.summary || '-'}`,
    `Pricing hint: ${analysis.pricingHint || '-'}`,
    '',
    'Task plan:',
    job.workflow?.project?.taskPlan || buildDefaultTaskPlan(job),
    '',
    'Original job detail:',
    job.detail || '-',
    '',
    'Client/company notes:',
    job.hideDetail || '-'
  ].join('\n');
}

function buildWorkerPromptFromDom(job) {
  const project = job.workflow?.project || {};
  const prompt = project.workerPrompt || buildWorkerPrompt(job);
  const conversation = document.querySelector('#conversationInput')?.value || project.conversation || '';
  const taskPlan = document.querySelector('#taskPlanInput')?.value || project.taskPlan || buildDefaultTaskPlan(job);
  const deliverables = document.querySelector('#deliverablesNoteInput')?.value || project.deliverablesNote || '';

  return [
    prompt,
    '',
    'Latest manager-side fields:',
    '',
    'Client conversation:',
    conversation || '-',
    '',
    'Task plan:',
    taskPlan || '-',
    '',
    'Deliverables note:',
    deliverables || '-'
  ].join('\n');
}

function buildEmailDraftText(job) {
  const draft = job.workflow?.draft || job.aiAnalysis?.emailDraft;
  if (!draft?.body) return '';
  return [`Subject: ${draft.subject}`, '', draft.body].join('\n');
}

function exportCsv() {
  const rows = [
    [
      'job_id',
      'created_at_hk',
      'status',
      'title',
      'client_id',
      'client_name',
      'client_email',
      'pipeline_status',
      'project_status',
      'project_folder',
      'ai_status',
      'ai_score',
      'ai_summary',
      'next_step',
      'category',
      'skills',
      'budget',
      'duration',
      'location',
      'detail',
      'client_notes'
    ],
    ...state.filteredJobs.map((job) => [
      job.id,
      formatDate(job.createdAtSeconds),
      job.status,
      job.title,
      job.clientId || '',
      job.clientName,
      job.clientEmail,
      pipelineStatusLabels[job.workflow?.pipelineStatus] || job.workflow?.pipelineStatus || '',
      projectStatusLabels[job.workflow?.project?.projectStatus] || job.workflow?.project?.projectStatus || '',
      job.workflow?.project?.folderPath || '',
      aiStatusLabels[job.aiAnalysis?.status] || job.aiAnalysis?.status || '',
      job.aiAnalysis?.score ?? '',
      job.aiAnalysis?.summary || '',
      nextStepLabels[job.aiAnalysis?.recommendedNextStep] || job.aiAnalysis?.recommendedNextStep || '',
      job.categoryName,
      (job.skills || []).join('; '),
      job.budget,
      durationLabels[job.duration] || job.duration,
      [job.location, job.posterLocation].filter(Boolean).join(' / '),
      job.detail,
      job.hideDetail
    ])
  ];

  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `freehunter-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
