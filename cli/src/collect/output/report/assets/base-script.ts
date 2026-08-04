/** Browser-side behavior shared by every generated single-file report. */
export const REPORT_SCRIPT = `
const reportStartedAt = window.__doctorReportStartedAt ?? performance.now();
document.querySelectorAll('.sidebar a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    const target = document.querySelector(link.getAttribute('href'));
    let parent = target && target.parentElement;
    while (parent) {
      if (parent.tagName === 'DETAILS') parent.open = true;
      parent = parent.parentElement;
    }
  });
});

function enhanceDataTable(table) {
  const rows = Array.from(table.tBodies[0]?.rows ?? []);
  if (!rows.length) return;
  rows.forEach((row, index) => { row.dataset.originalIndex = String(index); });
  const wrapper = table.closest('.table-view');
  const controls = wrapper?.querySelector('.table-controls');
  const pageSizeSelect = controls?.querySelector('.table-page-size');
  const pageInfo = controls?.querySelector('.table-page-info');
  const previous = controls?.querySelector('.table-page-previous');
  const next = controls?.querySelector('.table-page-next');
  const search = wrapper?.querySelector('.table-search');
  const searchColumn = Number(table.dataset.searchColumn);
  let pageSize = Number(table.dataset.pageSize) || 10;
  let currentPage = 1;
  let sortColumn = -1;
  let sortDirection = 1;

  function renderPage() {
    const query = search?.value.trim().toLocaleLowerCase() ?? '';
    const filteredRows = Number.isInteger(searchColumn)
      ? rows.filter((row) => (row.cells[searchColumn]?.textContent ?? '').toLocaleLowerCase().includes(query))
      : rows;
    const pageCount = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredRows.length / pageSize));
    currentPage = Math.min(currentPage, pageCount);
    const start = pageSize === 0 ? 0 : (currentPage - 1) * pageSize;
    const end = pageSize === 0 ? filteredRows.length : Math.min(filteredRows.length, start + pageSize);
    const visible = new Set(filteredRows.slice(start, end));
    rows.forEach((row) => { row.hidden = !visible.has(row); });
    if (controls) controls.hidden = rows.length <= 10;
    if (pageInfo) pageInfo.textContent = filteredRows.length
      ? (start + 1) + '–' + end + ' / ' + filteredRows.length
      : '0 / 0';
    if (previous) previous.disabled = currentPage <= 1;
    if (next) next.disabled = currentPage >= pageCount;
  }

  table.querySelectorAll('thead th').forEach((heading, column) => {
    heading.querySelector('.table-sort')?.addEventListener('click', () => {
      sortDirection = sortColumn === column ? -sortDirection : 1;
      sortColumn = column;
      const sortType = heading.dataset.sortType;
      rows.sort((left, right) => {
        const leftValue = left.cells[column]?.dataset.sortValue ?? '';
        const rightValue = right.cells[column]?.dataset.sortValue ?? '';
        let comparison;
        if (sortType === 'number') {
          const leftNumber = Number(leftValue);
          const rightNumber = Number(rightValue);
          const leftMissing = leftValue === '' || !Number.isFinite(leftNumber);
          const rightMissing = rightValue === '' || !Number.isFinite(rightNumber);
          if (leftMissing || rightMissing) {
            if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
            comparison = 0;
          } else {
            comparison = leftNumber - rightNumber;
          }
        } else {
          comparison = leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' });
        }
        return comparison
          ? comparison * sortDirection
          : Number(left.dataset.originalIndex) - Number(right.dataset.originalIndex);
      });
      rows.forEach((row) => table.tBodies[0].appendChild(row));
      table.querySelectorAll('thead th').forEach((item) => item.setAttribute('aria-sort', 'none'));
      heading.setAttribute('aria-sort', sortDirection === 1 ? 'ascending' : 'descending');
      currentPage = 1;
      renderPage();
    });
  });
  pageSizeSelect?.addEventListener('change', () => {
    pageSize = Number(pageSizeSelect.value);
    currentPage = 1;
    renderPage();
  });
  search?.addEventListener('input', () => { currentPage = 1; renderPage(); });
  previous?.addEventListener('click', () => { currentPage -= 1; renderPage(); });
  next?.addEventListener('click', () => { currentPage += 1; renderPage(); });
  renderPage();
}

function mountDataTable(wrapper, trigger) {
  if (wrapper.dataset.tableMounted === 'true') return;
  const startedAt = performance.now();
  const source = wrapper.querySelector('.table-data');
  const mount = wrapper.querySelector('.table-mount');
  try {
    const payload = JSON.parse(source?.textContent ?? '{}');
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'data-table';
    table.dataset.pageSize = String(payload.pageSize);
    if (payload.searchColumn !== undefined) table.dataset.searchColumn = String(payload.searchColumn);

    const thead = table.createTHead();
    const headingRow = thead.insertRow();
    payload.headers.forEach((header) => {
      const heading = document.createElement('th');
      heading.dataset.sortType = header.sortType;
      heading.setAttribute('aria-sort', 'none');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'table-sort';
      button.append(document.createTextNode(header.display));
      const marker = document.createElement('span');
      marker.className = 'sort-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = '↕';
      button.append(marker);
      heading.append(button);
      headingRow.append(heading);
    });

    const tbody = table.createTBody();
    payload.rows.forEach((cells, rowIndex) => {
      const row = tbody.insertRow();
      row.hidden = rowIndex >= payload.pageSize;
      cells.forEach((cell) => {
        const tableCell = row.insertCell();
        tableCell.dataset.sortValue = String(cell.sortValue);
        tableCell.textContent = cell.display;
      });
    });
    scroll.append(table);
    mount?.replaceChildren(scroll);
    wrapper.dataset.tableMounted = 'true';
    source?.remove();
    enhanceDataTable(table);
    console.log('[doctor-report] table:mounted', {
      table: Number(wrapper.dataset.tableIndex),
      trigger,
      rows: payload.rows.length,
      columns: payload.headers.length,
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
    });
  } catch (error) {
    if (mount) mount.textContent = '表格渲染失败，请打开控制台查看错误。';
    console.error('[doctor-report] table:mount-failed', {
      table: Number(wrapper.dataset.tableIndex),
      trigger,
      error,
    });
  }
}

const tableViews = document.querySelectorAll('.table-view');
tableViews.forEach((wrapper, index) => {
  wrapper.dataset.tableIndex = String(index + 1);
  const searchLabel = wrapper.querySelector('.table-search-label');
  const search = wrapper.querySelector('.table-search');
  searchLabel?.addEventListener('click', (event) => { event.stopPropagation(); });
  searchLabel?.addEventListener('keydown', (event) => { event.stopPropagation(); });
  search?.addEventListener('focus', () => {
    wrapper.open = true;
    mountDataTable(wrapper, 'search-focus');
  });
  wrapper.addEventListener('toggle', () => {
    if (wrapper.open) mountDataTable(wrapper, 'expand');
  });
});
window.addEventListener('beforeprint', () => {
  tableViews.forEach((wrapper) => mountDataTable(wrapper, 'print'));
});
document.querySelectorAll('.report-switcher').forEach((switcher) => {
  const select = switcher.querySelector('.report-switcher-select');
  const panels = switcher.querySelectorAll('.report-switcher-panel');
  select?.addEventListener('change', () => {
    panels.forEach((panel) => { panel.hidden = panel.dataset.switcherValue !== select.value; });
  });
});
document.querySelectorAll('.report-cascade-switcher').forEach((switcher) => {
  const parentSelect = switcher.querySelector('.report-cascade-parent-select');
  const childSelect = switcher.querySelector('.report-cascade-child-select');
  const childOptions = Array.from(childSelect?.options ?? []);
  const panels = switcher.querySelectorAll('.report-cascade-panel');

  function renderCascade() {
    const parentValue = parentSelect?.value;
    const visibleOptions = childOptions.filter((option) => option.dataset.cascadeParent === parentValue);
    childOptions.forEach((option) => {
      const visible = option.dataset.cascadeParent === parentValue;
      option.hidden = !visible;
      option.disabled = !visible;
    });
    if (childSelect && !visibleOptions.some((option) => option.value === childSelect.value)) {
      childSelect.value = visibleOptions[0]?.value ?? '';
    }
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.cascadeValue !== childSelect?.value;
    });
  }

  parentSelect?.addEventListener('change', renderCascade);
  childSelect?.addEventListener('change', renderCascade);
  renderCascade();
});

console.log('[doctor-report] dom:ready', {
  durationMs: Number((performance.now() - reportStartedAt).toFixed(1)),
  domNodes: document.getElementsByTagName('*').length,
  deferredTables: tableViews.length,
});
requestAnimationFrame(() => requestAnimationFrame(() => {
  console.log('[doctor-report] frame:ready', {
    durationMs: Number((performance.now() - reportStartedAt).toFixed(1)),
  });
}));
`;
