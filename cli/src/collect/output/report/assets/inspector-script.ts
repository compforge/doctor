/** Optional HTTP exchange inspector behavior; only embedded when a report declares an overlay. */
export const INSPECTOR_REPORT_SCRIPT = `
const copyToast = document.querySelector('.copy-toast');
let copyToastTimer;

function showCopyToast(message, failed) {
  if (!copyToast) return;
  copyToast.textContent = message;
  copyToast.style.background = failed ? '#991b1b' : '#166534';
  copyToast.hidden = false;
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => { copyToast.hidden = true; }, 1800);
}

async function copyReportText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error('Clipboard API unavailable');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy command failed');
  }
}

function activateExchangeTab(button) {
  const group = button.closest('[data-tab-group]');
  const target = button.dataset.tabTarget;
  const tabList = group?.querySelector(':scope > .exchange-tab-list');
  const panels = group?.querySelector(':scope > .exchange-tab-panels');
  if (!group || !target || !tabList || !panels) return;
  tabList.querySelectorAll(':scope > [data-tab-target]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab === button));
  });
  panels.querySelectorAll(':scope > [data-tab-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== target;
  });
}

function filterSseEvents(input) {
  const query = input.value.trim().toLocaleLowerCase();
  const container = input.closest('.exchange-sse-view');
  container?.querySelectorAll('.exchange-sse-event').forEach((event) => {
    event.hidden = query.length > 0 && !(event.textContent ?? '').toLocaleLowerCase().includes(query);
  });
}

function closeInspector() {
  const inspector = document.querySelector('.report-inspector');
  if (inspector) inspector.hidden = true;
  document.querySelectorAll('[data-inspector-id].is-selected').forEach((item) => {
    item.classList.remove('is-selected');
  });
}

function startInspectorDrag(event, toolbar) {
  if (event.button !== 0 || event.target.closest('.report-inspector-close')) return;
  const inspector = toolbar.closest('.report-inspector');
  if (!inspector) return;
  const rect = inspector.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  inspector.style.left = rect.left + 'px';
  inspector.style.top = rect.top + 'px';
  toolbar.classList.add('is-dragging');
  toolbar.setPointerCapture(event.pointerId);
  event.preventDefault();

  function move(moveEvent) {
    const maxLeft = Math.max(0, window.innerWidth - inspector.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - inspector.offsetHeight);
    inspector.style.left = Math.min(maxLeft, Math.max(0, moveEvent.clientX - offsetX)) + 'px';
    inspector.style.top = Math.min(maxTop, Math.max(0, moveEvent.clientY - offsetY)) + 'px';
  }

  function stop() {
    toolbar.classList.remove('is-dragging');
    toolbar.removeEventListener('pointermove', move);
    toolbar.removeEventListener('pointerup', stop);
    toolbar.removeEventListener('pointercancel', stop);
  }

  toolbar.addEventListener('pointermove', move);
  toolbar.addEventListener('pointerup', stop);
  toolbar.addEventListener('pointercancel', stop);
}

function selectInspector(trigger) {
  const id = trigger.dataset.inspectorId;
  const inspector = document.querySelector('.report-inspector');
  const template = Array.from(inspector?.querySelectorAll('template[data-inspector-template]') ?? [])
    .find((item) => item.dataset.inspectorTemplate === id);
  const selection = inspector?.querySelector('.inspector-selection');
  if (!template || !selection || !inspector) return;
  selection.replaceChildren(template.content.cloneNode(true));
  selection.hidden = false;
  inspector.hidden = false;
  document.querySelectorAll('[data-inspector-id]').forEach((item) => {
    item.classList.toggle('is-selected', item.dataset.inspectorId === id);
  });
}

document.addEventListener('click', async (event) => {
  const element = event.target instanceof Element ? event.target : null;
  const copyButton = element?.closest('.copy-text-button');
  if (copyButton) {
    const copySource = copyButton.closest('.exchange-copy-block')?.querySelector('.exchange-copy-source');
    try {
      await copyReportText(copySource?.textContent ?? '');
      showCopyToast('内容已复制', false);
    } catch {
      showCopyToast('复制失败，请手动复制', true);
    }
    return;
  }
  const tab = element?.closest('[data-tab-target]');
  if (tab) {
    activateExchangeTab(tab);
    return;
  }
  if (element?.closest('.report-inspector-close')) {
    closeInspector();
    return;
  }
  const trigger = element?.closest('[data-inspector-id]');
  if (trigger) selectInspector(trigger);
});
document.addEventListener('pointerdown', (event) => {
  const toolbar = event.target instanceof Element
    ? event.target.closest('.report-inspector-toolbar')
    : null;
  if (toolbar) startInspectorDrag(event, toolbar);
});
document.addEventListener('input', (event) => {
  const input = event.target instanceof Element ? event.target.closest('.exchange-sse-search') : null;
  if (input instanceof HTMLInputElement) filterSseEvents(input);
});
document.addEventListener('contextmenu', (event) => {
  const trigger = event.target instanceof Element
    ? event.target.closest('[data-inspector-id]')
    : null;
  if (!trigger) return;
  event.preventDefault();
  selectInspector(trigger);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('.report-inspector')?.hidden) {
    closeInspector();
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const trigger = event.target instanceof Element
    ? event.target.closest('[data-inspector-id]')
    : null;
  if (!trigger) return;
  event.preventDefault();
  selectInspector(trigger);
});
`;
