export const LOG_REPORT_SCRIPT = `
function mountLogViewer(viewer) {
  const source = viewer.querySelector('.log-viewer-data');
  const search = viewer.querySelector('.log-search');
  const serviceFilter = viewer.querySelector('.log-service-filter');
  const podFilter = viewer.querySelector('.log-pod-filter');
  const startInput = viewer.querySelector('.log-start-time');
  const endInput = viewer.querySelector('.log-end-time');
  const reset = viewer.querySelector('.log-reset');
  const histogram = viewer.querySelector('.log-histogram');
  const resultMeta = viewer.querySelector('.log-result-meta');
  const list = viewer.querySelector('.log-list');
  const pageInfo = viewer.querySelector('.log-page-info');
  const previousPage = viewer.querySelector('.log-page-previous');
  const nextPage = viewer.querySelector('.log-page-next');
  const previousMatch = viewer.querySelector('.log-match-previous');
  const nextMatch = viewer.querySelector('.log-match-next');
  const errorsView = viewer.querySelector('.log-errors');
  const errorsBody = viewer.querySelector('.log-errors-body');
  const pageSize = 100;
  let records;
  try {
    records = JSON.parse(source?.textContent ?? '[]');
  } catch (error) {
    list.textContent = '日志数据解析失败，请打开控制台查看错误。';
    console.error('[doctor-report] log-viewer:parse-failed', error);
    return;
  }
  const logs = records.filter((record) => record.kind === 'log');
  const errors = records.filter((record) => record.kind === 'collection_error');
  const services = Array.from(new Set(logs.map((record) => record.service))).sort();
  const serviceColors = ['#2563eb','#7c3aed','#0f766e','#c2410c','#be123c','#4d7c0f','#0369a1','#a21caf'];
  const streamRecords = new Map();
  logs.forEach((record) => {
    record._timestampMs = record.timestamp ? Date.parse(record.timestamp) : NaN;
    record._searchText = [record.service, record.pod, record.container ?? '', record.message]
      .join(' ').toLocaleLowerCase();
    const key = record.service + '\\u0000' + record.pod + '\\u0000'
      + (record.container ?? '') + '\\u0000' + record.instance;
    const stream = streamRecords.get(key) ?? [];
    stream.push(record);
    streamRecords.set(key, stream);
  });
  const streamPositions = new Map();
  streamRecords.forEach((stream) => stream.forEach((record, index) => {
    streamPositions.set(record.sequence, { stream, index });
  }));
  let filtered = logs;
  let currentPage = 0;
  let activeMatch = 0;
  let searchTimer;

  function populateSelect(select, values, label) {
    const previous = select.value;
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = label;
    select.append(all);
    values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    });
    select.value = values.includes(previous) ? previous : '';
  }

  function refreshPodOptions() {
    const selectedService = serviceFilter.value;
    const pods = Array.from(new Set(logs
      .filter((record) => !selectedService || record.service === selectedService)
      .map((record) => record.pod))).sort();
    populateSelect(podFilter, pods, '全部 Pod');
  }

  function timeValue(input) {
    if (!input.value) return undefined;
    const value = new Date(input.value).getTime();
    return Number.isFinite(value) ? value : undefined;
  }

  function localInputValue(timestampMs) {
    const local = new Date(timestampMs - new Date(timestampMs).getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 19);
  }

  function baseFilteredLogs() {
    const query = search.value.trim().toLocaleLowerCase();
    const service = serviceFilter.value;
    const pod = podFilter.value;
    return logs.filter((record) =>
      (!query || record._searchText.includes(query))
      && (!service || record.service === service)
      && (!pod || record.pod === pod)
    );
  }

  function renderHistogram(base) {
    histogram.replaceChildren();
    const timed = base.filter((record) => Number.isFinite(record._timestampMs));
    if (!timed.length) {
      const empty = document.createElement('span');
      empty.className = 'log-histogram-empty';
      empty.textContent = '当前结果没有可用时间戳';
      histogram.append(empty);
      return;
    }
    let min = timed[0]._timestampMs;
    let max = timed[0]._timestampMs;
    timed.forEach((record) => {
      min = Math.min(min, record._timestampMs);
      max = Math.max(max, record._timestampMs);
    });
    const binCount = Math.min(48, Math.max(1, Math.ceil(Math.sqrt(timed.length))));
    const width = Math.max(1, (max - min + 1) / binCount);
    const bins = Array.from({ length: binCount }, () => 0);
    timed.forEach((record) => {
      const index = Math.min(binCount - 1, Math.floor((record._timestampMs - min) / width));
      bins[index] += 1;
    });
    const maxCount = Math.max(...bins, 1);
    bins.forEach((count, index) => {
      const start = min + index * width;
      const end = index === binCount - 1 ? max + 1 : start + width;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'log-histogram-bar';
      button.style.setProperty('--bar-height', Math.max(3, count / maxCount * 100) + '%');
      button.title = new Date(start).toLocaleString() + ' · ' + count + ' 条事件';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => {
        startInput.value = localInputValue(start);
        endInput.value = localInputValue(end);
        applyFilters();
      });
      histogram.append(button);
    });
  }

  function appendHighlighted(container, text, rawQuery) {
    const query = rawQuery.toLocaleLowerCase();
    if (!query) {
      container.textContent = text;
      return;
    }
    const lower = text.toLocaleLowerCase();
    let cursor = 0;
    let index = lower.indexOf(query);
    while (index >= 0) {
      container.append(document.createTextNode(text.slice(cursor, index)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(index, index + rawQuery.length);
      container.append(mark);
      cursor = index + rawQuery.length;
      index = lower.indexOf(query, cursor);
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function sourceColor(service) {
    const index = Math.max(0, services.indexOf(service));
    return serviceColors[index % serviceColors.length];
  }

  function appendContext(container, record) {
    const location = streamPositions.get(record.sequence);
    if (!location) return;
    const start = Math.max(0, location.index - 3);
    const end = Math.min(location.stream.length, location.index + 4);
    location.stream.slice(start, end).forEach((item) => {
      if (item.sequence === record.sequence) return;
      const line = document.createElement('div');
      line.className = 'log-context-line';
      const time = document.createElement('time');
      time.textContent = item.timestamp ? new Date(item._timestampMs).toLocaleString() : '—';
      const message = document.createElement('code');
      message.textContent = item.message;
      line.append(time, message);
      container.append(line);
    });
  }

  function logRow(record, filteredIndex) {
    const row = document.createElement('article');
    row.className = 'log-row';
    row.dataset.sequence = String(record.sequence);
    row.style.setProperty('--source-color', sourceColor(record.service));
    if (filteredIndex === activeMatch && search.value.trim()) row.classList.add('is-active-match');
    const header = document.createElement('div');
    header.className = 'log-row-header';
    const time = document.createElement('time');
    time.textContent = record.timestamp ? new Date(record._timestampMs).toLocaleString() : '无时间戳';
    time.title = record.timestamp ?? '';
    const service = document.createElement('span');
    service.className = 'log-source';
    service.textContent = record.service;
    const pod = document.createElement('span');
    pod.textContent = record.pod;
    const container = document.createElement('span');
    container.textContent = record.container ?? '';
    const instance = document.createElement('span');
    instance.className = record.instance === 'previous' ? 'log-instance-previous' : '';
    instance.textContent = record.instance;
    const contextButton = document.createElement('button');
    contextButton.type = 'button';
    contextButton.className = 'log-context-button';
    contextButton.textContent = '上下文';
    header.append(time, service, pod, container, instance, contextButton);
    const message = document.createElement('pre');
    message.className = 'log-message';
    appendHighlighted(message, record.message, search.value.trim());
    const context = document.createElement('div');
    context.className = 'log-context';
    context.hidden = true;
    contextButton.addEventListener('click', () => {
      if (!context.childNodes.length) appendContext(context, record);
      context.hidden = !context.hidden;
      contextButton.textContent = context.hidden ? '上下文' : '收起上下文';
    });
    row.append(header, message, context);
    return row;
  }

  function renderPage() {
    list.replaceChildren();
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    currentPage = Math.min(currentPage, pageCount - 1);
    const start = currentPage * pageSize;
    const end = Math.min(filtered.length, start + pageSize);
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '没有符合当前筛选条件的日志';
      list.append(empty);
    } else {
      filtered.slice(start, end).forEach((record, index) => {
        list.append(logRow(record, start + index));
      });
    }
    pageInfo.textContent = filtered.length ? (start + 1) + '–' + end + ' / ' + filtered.length : '0 / 0';
    previousPage.disabled = currentPage <= 0;
    nextPage.disabled = currentPage >= pageCount - 1;
  }

  function applyFilters() {
    const base = baseFilteredLogs();
    const start = timeValue(startInput);
    const end = timeValue(endInput);
    filtered = base.filter((record) =>
      (start === undefined || Number.isFinite(record._timestampMs) && record._timestampMs >= start)
      && (end === undefined || Number.isFinite(record._timestampMs) && record._timestampMs <= end)
    );
    currentPage = 0;
    activeMatch = 0;
    resultMeta.textContent = '显示 ' + filtered.length + ' / ' + logs.length + ' 条事件';
    const hasQuery = search.value.trim().length > 0 && filtered.length > 0;
    previousMatch.disabled = !hasQuery;
    nextMatch.disabled = !hasQuery;
    renderHistogram(base);
    renderPage();
  }

  function moveMatch(delta) {
    if (!filtered.length || !search.value.trim()) return;
    activeMatch = (activeMatch + delta + filtered.length) % filtered.length;
    currentPage = Math.floor(activeMatch / pageSize);
    renderPage();
    requestAnimationFrame(() => {
      list.querySelector('.log-row.is-active-match')?.scrollIntoView({ block:'center', behavior:'smooth' });
    });
  }

  populateSelect(serviceFilter, services, '全部 Service');
  refreshPodOptions();
  if (errors.length && errorsView && errorsBody) {
    errorsView.hidden = false;
    errorsView.querySelector('.log-error-count').textContent = String(errors.length);
    errorsBody.textContent = errors.map((record) =>
      '[service/' + record.service + ' pod/' + record.pod + '] ' + record.message
    ).join('\\n');
  }
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 120);
  });
  serviceFilter.addEventListener('change', () => { refreshPodOptions(); applyFilters(); });
  podFilter.addEventListener('change', applyFilters);
  startInput.addEventListener('change', applyFilters);
  endInput.addEventListener('change', applyFilters);
  reset.addEventListener('click', () => {
    search.value = '';
    serviceFilter.value = '';
    refreshPodOptions();
    podFilter.value = '';
    startInput.value = '';
    endInput.value = '';
    applyFilters();
  });
  viewer.querySelectorAll('.log-quick-filter').forEach((button) => {
    button.addEventListener('click', () => { search.value = button.dataset.query ?? ''; applyFilters(); });
  });
  previousPage.addEventListener('click', () => { currentPage -= 1; renderPage(); });
  nextPage.addEventListener('click', () => { currentPage += 1; renderPage(); });
  previousMatch.addEventListener('click', () => moveMatch(-1));
  nextMatch.addEventListener('click', () => moveMatch(1));
  applyFilters();
  source?.remove();
  console.log('[doctor-report] log-viewer:mounted', { rows:logs.length, errors:errors.length });
}

document.querySelectorAll('.log-viewer').forEach(mountLogViewer);
`;
