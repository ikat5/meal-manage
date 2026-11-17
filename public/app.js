import { approximateMealRate, calculateBalances, mealPortions, memberHistory, slots } from './model.js';

const app = document.querySelector('#app');
const drawer = document.querySelector('#drawer');
const pageNames = ['balances', 'members', 'deposits', 'meals', 'groceries'];
const titles = { balances: 'Balances', members: 'Members', deposits: 'Deposits', meals: 'Meals', groceries: 'Groceries' };
const actions = { balances: 'Add deposit', members: 'Add member', deposits: 'Add deposit', meals: 'Log meal', groceries: 'Add purchase' };
const recordLabels = { members: 'member', deposits: 'deposit', meals: 'meal', groceries: 'purchase' };
let session;
let data = { members: [], deposits: [], meals: [], groceries: [] };
let page = 'balances';
let filter = '';
let lastFocus;
let noticeTimer;

const paths = {
  balances: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  deposits: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18m-9 3v5m-2-2 2 2 2-2"/>',
  meals: '<path d="M4 3v6a2 2 0 0 0 4 0V3M6 3v18m12 0V3c-4 3-5 9 0 10"/>',
  groceries: '<path d="m3 3 2 2 3 12h11l3-10H6m2 14h.01M19 21h.01"/><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M12 2v10m6.36-6.36a9 9 0 1 1-12.72 0"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  wallet: '<path d="M20 8V5a2 2 0 0 0-2-2L5 6a3 3 0 0 0-2 3v10a2 2 0 0 0 2 2h15V8H6a3 3 0 0 1-3-2m17 7h-5v4h5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.balances}</svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value) => new Intl.NumberFormat('en-BD', { maximumFractionDigits: 2 }).format(value);
const money = (paisa) => `৳${number(paisa / 100)}`;
const signedMoney = (paisa) => `${paisa > 0 ? '+' : paisa < 0 ? '−' : ''}${money(Math.abs(paisa))}`;
const dateText = (date, time = false) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: true } : {}) }).format(new Date(date));
const localNow = (value) => { const date = value ? new Date(value) : new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const memberName = (id) => data.members.find((member) => member.id === id)?.name || 'Unknown member';
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const avatar = (member) => `<span class="avatar tone-${member.id % 4}" aria-hidden="true">${esc(initials(member.name))}</span>`;
const personCell = (member) => `<span class="person">${avatar(member)}<span>${esc(member.name)}</span></span>`;
const balanceClass = (amount) => amount > 0 ? 'positive' : amount < 0 ? 'negative' : 'muted';
const columnAlignments = {
  balances: ['start', 'end', 'end', 'end', 'end', 'end', 'end'],
  members: ['start', 'start', 'start', 'end', 'end'],
  deposits: ['start', 'start', 'end', 'end'],
  meals: ['start', 'start', 'start', 'start', 'end', 'end', 'end', 'end'],
  groceries: ['start', 'start', 'end', 'start', 'end'],
};
const dateCell = (value, time = false) => `<time class="date-cell" datetime="${esc(value)}"><span>${dateText(value)}</span>${time ? `<span class="cell-meta">${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value))}</span>` : ''}</time>`;

async function api(route, body, method = 'POST') {
  let response;
  try {
    response = await fetch(`/api/${route}`, body === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Error('Could not connect. Please try again.'); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== 'login') {
      if (drawer.open) drawer.close();
      session.authenticated = false;
      navigate('/login');
    }
    const error = new Error(result.error);
    error.field = result.field;
    throw error;
  }
  return result;
}

function notify(message) {
  const notice = document.querySelector('#notice');
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.add('visible');
  noticeTimer = setTimeout(() => notice.classList.remove('visible'), 3500);
}

function navigate(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  renderRoute();
}

function renderRoute() {
  if (!session.authenticated) {
    if (location.pathname !== '/login') history.replaceState({}, '', '/login');
    return renderLogin();
  }
  const nextPage = location.pathname.slice(1);
  page = pageNames.includes(nextPage) ? nextPage : 'balances';
  if (nextPage !== page) history.replaceState({}, '', `/${page}`);
  filter = '';
  renderShell();
}

function renderLogin() {
  document.title = `${session.messName} · Log in`;
  document.body.classList.remove('menu-is-open');
  app.className = 'login-page';
  delete app.dataset.page;
  app.innerHTML = `<main id="content" class="login-card" aria-label="Log in">
    <form id="login-form" novalidate>
      ${field('username', 'Username', '<input id="username" name="username" autocomplete="username" required maxlength="80">')}
      ${field('password', 'Password', '<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">')}
      <button type="submit" class="button primary btn btn--primary login-button">Log in ${icon('arrow')}</button>
      <p class="form-status" role="status"></p>
    </form>
  </main>`;
  app.removeAttribute('aria-busy');
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearErrors(form);
    const values = Object.fromEntries(new FormData(form));
    if (!values.username.trim()) return formError(form, 'Enter your username.', 'username');
    if (!values.password) return formError(form, 'Enter your password.', 'password');
    await submitForm(form, async () => {
      const user = await api('login', values);
      session = { ...session, authenticated: true, username: user.username };
      data = await api('data');
      navigate('/balances', true);
    });
  });
}

function renderShell() {
  document.title = `${titles[page]} · ${session.messName}`;
  app.className = 'app-shell';
  app.dataset.page = page;
  app.innerHTML = `
    <button class="sidebar-scrim" aria-label="Close navigation" tabindex="-1"></button>
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <a class="brand" href="/balances"><img class="brand-mark" src="/favicon.svg" width="36" height="36" alt=""><span>${esc(session.messName)}</span></a>
      <nav>${pageNames.map((name) => `<a href="/${name}" class="nav-link ${name === page ? 'active' : ''}" ${name === page ? 'aria-current="page"' : ''}>${icon(name)}<span class="m-link m-link--bare">${titles[name]}</span>${name === page ? '<span class="nav-dot" aria-hidden="true"></span>' : ''}</a>`).join('')}</nav>
      <div class="sidebar-account"><span class="account-avatar" aria-hidden="true">${esc(initials(session.username))}</span><span class="account-name">${esc(session.username)}</span><button class="icon-button btn" id="logout" aria-label="Log out">${icon('logout')}</button></div>
    </aside>
    <div class="workspace">
      <header class="page-header"><div class="page-heading"><button class="icon-button btn menu-toggle" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button><h1>${titles[page]}</h1></div><button class="button primary btn btn--primary" id="add-action">${icon('plus')}<span>${actions[page]}</span></button></header>
      <main id="content" class="page-content" tabindex="-1">${renderPage()}</main>
    </div>`;
  app.removeAttribute('aria-busy');
  app.querySelectorAll('a[href^="/"]').forEach((link) => link.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
    document.querySelector('#content').focus({ preventScroll: true });
  }));
  app.querySelector('#add-action').addEventListener('click', () => openForm(page === 'balances' ? 'deposits' : page));
  app.querySelector('#logout').addEventListener('click', async () => {
    try { await api('logout', {}); session.authenticated = false; data = { members: [], deposits: [], meals: [], groceries: [] }; navigate('/login', true); }
    catch (error) { notify(error.message); }
  });
  app.querySelector('.menu-toggle').addEventListener('click', () => setMenu(true));
  app.querySelector('.sidebar-scrim').addEventListener('click', () => setMenu(false));
  bindPage();
}

function setMenu(open) {
  const sidebar = document.querySelector('.sidebar');
  const workspace = document.querySelector('.workspace');
  const toggle = document.querySelector('.menu-toggle');
  const currentLink = sidebar.querySelector('.nav-link[aria-current="page"]');
  app.classList.toggle('menu-open', open);
  document.body.classList.toggle('menu-is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    currentLink.focus();
    workspace.inert = true;
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    workspace.inert = false;
    (toggle.getClientRects().length ? toggle : currentLink).focus();
  }
}

function table(headers, rows, empty, extraClass = '') {
  return `<div class="table-panel ${page}-table ${extraClass}"><div class="table-scroll" tabindex="0" role="region" aria-label="${titles[page]} table"><table role="table"><thead role="rowgroup"><tr role="row">${headers.map((header, index) => `<th scope="col" role="columnheader" class="${columnAlignments[page][index] === 'end' ? 'cell-end' : ''}">${header}</th>`).join('')}</tr></thead><tbody role="rowgroup">${rows || `<tr><td colspan="${headers.length}" class="empty-state">${empty}</td></tr>`}</tbody></table></div></div>`;
}

function rowActions(type, record) {
  const label = recordLabels[type];
  const description = type === 'members' ? record.name : type === 'meals' ? `${record.dish}, ${dateText(record.date)}` : `${money(record.amount)}, ${memberName(record.memberId)}`;
  return `<td class="actions-cell"><div class="row-actions"><button type="button" class="icon-button btn" data-edit="${record.id}" data-resource="${type}" aria-label="Edit ${label}: ${esc(description)}" title="Edit ${label}">${icon('edit')}</button><button type="button" class="icon-button btn delete-action" data-delete="${record.id}" data-resource="${type}" aria-label="Delete ${label}: ${esc(description)}" title="Delete ${label}">${icon('delete')}</button></div></td>`;
}

function renderPage() {
  const balance = calculateBalances(data);
  if (page === 'balances') {
    const stats = [
      ['Total deposited', balance.deposited, 'deposits'], ['Total spent', balance.spent, 'groceries'],
      ['Meal rate', balance.rate, 'meals'], ['Cash in hand', balance.cash, 'wallet'],
    ];
    return `<div class="stats-grid">${stats.map(([label, value, name]) => `<div class="stat-card"><div class="stat-label">${label}<span class="stat-icon">${icon(name)}</span></div><div class="stat-value ${name === 'wallet' && value < 0 ? 'negative' : ''}"><span class="stat-currency">৳</span><span class="stat-number">${number(value / 100)}</span></div></div>`).join('')}</div>
      ${table(['Member', 'Deposited', 'Meals', 'Cost', 'Balance', '<span class="sr-only">History</span>', 'Actions'], balance.rows.map((member) => `<tr class="balance-row"><td><button class="member-button" data-history="${member.id}">${personCell(member)}</button></td><td class="numeric">${money(member.deposited)}</td><td class="numeric muted">${number(member.meals)}</td><td class="numeric">${money(member.cost)}</td><td class="numeric"><span class="balance-amount ${balanceClass(member.balance)}">${signedMoney(member.balance)}</span></td><td class="row-end"><button class="icon-button btn" data-history="${member.id}" aria-label="View ${esc(member.name)} history">${icon('chevron')}</button></td>${rowActions('members', member)}</tr>`).join(''), 'No members yet', 'balances-table')}`;
  }
  if (page === 'members') return table(['Name', 'Phone', 'Joined date', 'Active', 'Actions'], data.members.map((member) => `<tr><td><button class="member-button" data-edit="${member.id}">${personCell(member)}</button></td><td class="cell-end muted">${esc(member.phone) || '—'}</td><td class="cell-end muted">${dateText(member.joined)}</td><td class="cell-end"><button class="switch" role="switch" aria-checked="${member.active}" aria-label="${member.active ? 'Deactivate' : 'Activate'} ${esc(member.name)}" data-toggle="${member.id}"><span></span></button></td>${rowActions('members', member)}</tr>`).join(''), 'No members yet');
  if (page === 'deposits') {
    const deposits = data.deposits.filter((entry) => !filter || entry.memberId === Number(filter));
    return `<div class="table-toolbar"><label class="sr-only" for="member-filter">Filter by member</label><select id="member-filter" class="filter-select"><option value="">All members</option>${data.members.map((member) => `<option value="${member.id}" ${filter === String(member.id) ? 'selected' : ''}>${esc(member.name)}</option>`).join('')}</select></div>
      ${table(['Date / time', 'Member', 'Amount', 'Actions'], deposits.map((entry) => `<tr><td>${dateCell(entry.date, true)}</td><td>${esc(memberName(entry.memberId))}</td><td class="numeric amount">${money(entry.amount)}</td>${rowActions('deposits', entry)}</tr>`).join(''), filter ? 'No deposits for this member' : 'No deposits yet')}`;
  }
  if (page === 'meals') {
    const rows = data.meals.map((meal) => {
      const rate = approximateMealRate(meal);
      return `<tr><td class="muted">${dateText(meal.date)}</td><td class="cell-end"><span class="slot slot-${meal.slot}">${esc(meal.slot)}</span></td><td class="cell-end dish-cell">${esc(meal.dish)}</td><td class="attendance-cell"><ul class="meal-attendance">${meal.attendees.map((person) => `<li><span>${esc(memberName(person.memberId))}</span><span class="portion-count">×${number(mealPortions(person))}</span></li>`).join('')}</ul></td><td class="numeric muted">${meal.approximateCost == null ? '—' : money(meal.approximateCost)}</td><td class="numeric muted">${rate == null ? '—' : money(rate)}</td><td class="numeric"><span class="portion-total">${icon('meals')}${number(meal.attendees.reduce((sum, person) => sum + mealPortions(person), 0))}</span></td>${rowActions('meals', meal)}</tr>`;
    }).join('');
    return table(['Date', 'Slot', 'What was cooked', 'Who ate / portions', 'Approx. cost <span class="column-unit">৳</span>', 'Approx. meal rate <span class="column-unit">৳ / portion</span>', 'Total portions', 'Actions'], rows, 'No meals yet');
  }
  return table(['Date / time', 'Items / note', 'Amount', 'Bought by', 'Actions'], data.groceries.map((entry) => `<tr><td>${dateCell(entry.date, true)}</td><td class="dish-cell">${esc(entry.note)}</td><td class="numeric amount">${money(entry.amount)}</td><td>${esc(memberName(entry.memberId))}</td>${rowActions('groceries', entry)}</tr>`).join(''), 'No purchases yet');
}

function bindPage() {
  document.body.classList.remove('menu-is-open');
  document.querySelectorAll('.table-panel table').forEach((tableElement) => {
    const headers = [...tableElement.querySelectorAll('thead th')];
    tableElement.querySelectorAll('tbody tr').forEach((row) => {
      row.setAttribute('role', 'row');
      [...row.cells].forEach((cell, index) => {
        cell.setAttribute('role', 'cell');
        if (cell.classList.contains('empty-state')) return;
        cell.dataset.label = headers[index].textContent.trim();
        cell.classList.toggle('cell-end', columnAlignments[page][index] === 'end');
      });
    });
  });
  document.querySelectorAll('[data-history]').forEach((button) => button.addEventListener('click', () => openHistory(Number(button.dataset.history))));
  document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
    const type = button.dataset.resource || 'members';
    openForm(type, data[type].find((record) => record.id === Number(button.dataset.edit)));
  }));
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => {
    const type = button.dataset.resource;
    openDelete(type, data[type].find((record) => record.id === Number(button.dataset.delete)));
  }));
  document.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
    const member = data.members.find((entry) => entry.id === Number(button.dataset.toggle));
    button.disabled = true;
    try {
      data = await api(`members/${member.id}`, { active: !member.active }, 'PUT');
      const updated = data.members.find((entry) => entry.id === member.id);
      button.setAttribute('aria-checked', String(updated.active));
      button.setAttribute('aria-label', `${updated.active ? 'Deactivate' : 'Activate'} ${updated.name}`);
      notify(updated.active ? 'Member activated' : 'Member deactivated');
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  }));
  document.querySelector('#member-filter')?.addEventListener('change', (event) => {
    filter = event.target.value;
    document.querySelector('#content').innerHTML = renderPage();
    bindPage();
    document.querySelector('#member-filter').focus();
  });
}

function field(name, label, input) {
  return `<div class="field" data-field="${name}"><label for="${name}">${label}</label>${input}<span class="field-error" id="${name}-error"></span></div>`;
}
function memberSelect(selected, name = 'memberId') {
  return `<select id="${name}" name="memberId" required><option value="">Select member</option>${data.members.map((member) => `<option value="${member.id}" ${selected === member.id ? 'selected' : ''}>${esc(member.name)}${member.active ? '' : ' (inactive)'}</option>`).join('')}</select>`;
}

function openDrawer(title, content) {
  lastFocus = document.activeElement;
  delete drawer.dataset.kind;
  drawer.innerHTML = `<div class="drawer-header"><h2 id="drawer-title">${esc(title)}</h2><button type="button" class="icon-button btn" data-close aria-label="Close drawer">${icon('close')}</button></div>${content}`;
  drawer.showModal();
  document.body.classList.add('drawer-is-open');
  drawer.querySelector('[data-close]').addEventListener('click', () => drawer.close());
}

function mealAttendeeField(member, attendance, editing) {
  const selected = editing ? Boolean(attendance) : true;
  const quantity = attendance ? mealPortions(attendance) : 1;
  return `<div class="attendee-row" data-attendee="${member.id}"><label class="check-label"><input type="checkbox" name="attendee" value="${member.id}" ${selected ? 'checked' : ''}><span class="custom-check">${icon('check')}</span>${avatar(member)}<span>${esc(member.name)}${member.active ? '' : ' (inactive)'}</span></label><div class="attendee-quantities">${field(`quantity-${member.id}`, 'Portions', `<div class="portion-stepper"><button class="icon-button btn portion-decrement" type="button" aria-label="Decrease portions for ${esc(member.name)}" ${!selected || quantity <= 1 ? 'disabled' : ''}>${icon('minus')}</button><input id="quantity-${member.id}" data-quantity type="number" inputmode="numeric" min="1" max="40" step="1" value="${quantity}" aria-label="Portions for ${esc(member.name)}" ${selected ? '' : 'disabled'} required><button class="icon-button btn portion-increment" type="button" aria-label="Increase portions for ${esc(member.name)}" ${!selected || quantity >= 40 ? 'disabled' : ''}>${icon('plus')}</button></div>`)}</div></div>`;
}

function focusRecordAction(type, id) {
  const action = document.querySelector(`[data-resource="${type}"][data-edit="${id}"]`) || document.querySelector('#add-action');
  action?.focus();
}

function openForm(type, record) {
  const label = recordLabels[type];
  const title = record ? `Edit ${label}` : actions[type];
  const submitLabel = record ? `Save ${label}` : title;
  const dateValue = record?.date ? localNow(record.date) : localNow();
  const amount = record?.amount == null ? '' : (record.amount / 100).toFixed(2);
  const amountInput = `<input id="amount" name="amount" type="number" inputmode="decimal" min="0.01" max="99999999.99" step="0.01" value="${amount}" required>`;
  const dateInput = `<input id="date" name="date" type="datetime-local" step="1" value="${dateValue}" required>`;
  let fields = '';
  if (type === 'members') fields = `${field('name', 'Name', `<input id="name" name="name" autocomplete="name" maxlength="80" value="${esc(record?.name || '')}" required>`)}${field('phone', 'Phone', `<input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="40" value="${esc(record?.phone || '')}">`)}`;
  if (type === 'deposits') fields = `${field('memberId', 'Member', memberSelect(record?.memberId))}${field('amount', 'Amount (৳)', amountInput)}${field('date', 'Date / time', dateInput)}`;
  if (type === 'groceries') fields = `${field('date', 'Date / time', dateInput)}${field('amount', 'Amount (৳)', amountInput)}${field('note', 'Items / note', `<textarea id="note" name="note" rows="3" maxlength="500" required>${esc(record?.note || '')}</textarea>`)}${field('memberId', 'Bought by', memberSelect(record?.memberId))}`;
  if (type === 'meals') {
    const attendance = new Map((record?.attendees || []).map((person) => [person.memberId, person]));
    const members = data.members.filter((member) => member.active || attendance.has(member.id));
    const approximateCost = record?.approximateCost == null ? '' : (record.approximateCost / 100).toFixed(2);
    fields = `<div class="field-row">${field('date', 'Date', `<input id="date" name="date" type="date" value="${record?.date || localNow().slice(0, 10)}" required>`)}${field('slot', 'Slot', `<select id="slot" name="slot">${slots.map((slot) => `<option value="${slot}" ${slot === (record?.slot || slots[0]) ? 'selected' : ''}>${slot[0].toUpperCase() + slot.slice(1)}</option>`).join('')}</select>`)}</div>${field('dish', 'What was cooked', `<input id="dish" name="dish" maxlength="200" value="${esc(record?.dish || '')}" required>`)}
      <div class="field-row">${field('approximateCost', 'Approx. total cost (৳, optional)', `<input id="approximateCost" name="approximateCost" type="number" inputmode="decimal" min="0" max="99999999.99" step="0.01" value="${approximateCost}">`)}<div class="field"><label for="meal-rate-preview">Approx. meal rate (৳ / portion)</label><output class="rate-preview" id="meal-rate-preview">—</output></div></div>
      <fieldset class="attendee-field" data-field="attendees"><legend>Members</legend><div class="attendee-columns" aria-hidden="true"><span>Member</span><span>Portions</span></div><div class="attendee-list meal-members">${members.map((member) => mealAttendeeField(member, attendance.get(member.id), Boolean(record))).join('') || '<div class="check-empty">No active members yet</div>'}</div><span class="field-error" id="attendees-error"></span></fieldset>`;
  }
  openDrawer(title, `<form id="entry-form" class="drawer-form" novalidate><div class="drawer-fields">${fields}</div><div class="drawer-footer"><p class="form-status" role="status"></p><div class="form-actions"><button type="button" class="button secondary btn btn--secondary" data-cancel>Cancel</button><button type="submit" class="button primary btn btn--primary">${submitLabel}</button></div></div></form>`);
  drawer.dataset.kind = type;
  drawer.querySelector('[data-cancel]').addEventListener('click', () => drawer.close());
  const updateMealPreview = () => {
    if (type !== 'meals') return;
    const cost = drawer.querySelector('#approximateCost');
    const selected = [...drawer.querySelectorAll('[data-attendee]')].filter((row) => row.querySelector('input[type="checkbox"]').checked);
    const valid = cost.value !== '' && cost.checkValidity() && selected.length && selected.every((row) => row.querySelector('[data-quantity]').checkValidity());
    const rate = valid ? approximateMealRate({
      approximateCost: Math.round(Number(cost.value) * 100),
      attendees: selected.map((row) => ({ quantity: Number(row.querySelector('[data-quantity]').value), guests: 0 })),
    }) : null;
    drawer.querySelector('#meal-rate-preview').textContent = rate == null ? '—' : money(rate);
  };
  drawer.querySelector('form').addEventListener('input', updateMealPreview);
  drawer.querySelectorAll('[data-attendee]').forEach((row) => {
    const decrement = row.querySelector('.portion-decrement');
    const increment = row.querySelector('.portion-increment');
    const checkbox = row.querySelector('input[type="checkbox"]');
    const quantity = row.querySelector('[data-quantity]');
    const update = (change = 0) => {
      if (change) {
        const current = Number.isFinite(quantity.valueAsNumber) ? quantity.valueAsNumber : 0;
        quantity.value = Math.max(1, Math.min(40, Math.trunc(current) + change));
      }
      quantity.disabled = !checkbox.checked;
      decrement.disabled = !checkbox.checked || quantity.valueAsNumber <= 1;
      increment.disabled = !checkbox.checked || quantity.valueAsNumber >= 40;
      updateMealPreview();
    };
    decrement.addEventListener('click', () => update(-1));
    increment.addEventListener('click', () => update(1));
    checkbox.addEventListener('change', () => update());
    quantity.addEventListener('input', () => update());
  });
  updateMealPreview();
  drawer.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearErrors(form);
    const invalid = [...form.querySelectorAll('input, select, textarea')].find((input) => !input.checkValidity());
    if (invalid) return formError(form, invalid.validity.valueMissing ? `Enter ${invalid.labels?.[0]?.textContent.toLowerCase() || 'a value'}.` : 'Enter a valid value.', invalid.name || invalid.id);
    const values = Object.fromEntries(new FormData(form));
    if ('memberId' in values) values.memberId = Number(values.memberId);
    if (values.date && type !== 'meals') {
      // Preserve sub-second precision when the original date/time was not changed.
      const timestamp = new Date(values.date).getTime();
      values.date = record && timestamp === Math.floor(new Date(record.date).getTime() / 1000) * 1000 ? record.date : new Date(timestamp).toISOString();
    }
    if (type === 'meals') {
      delete values.attendee;
      values.attendees = [...form.querySelectorAll('[data-attendee]')].filter((row) => row.querySelector('input[type="checkbox"]').checked).map((row) => ({ memberId: Number(row.dataset.attendee), quantity: Number(row.querySelector('[data-quantity]').value), guests: 0 }));
      if (!values.attendees.length) return formError(form, 'Select at least one member.', 'attendees');
    }
    await submitForm(form, async () => {
      data = await api(record ? `${type}/${record.id}` : type, values, record ? 'PUT' : 'POST');
      drawer.close();
      renderShell();
      notify(record ? `${label[0].toUpperCase() + label.slice(1)} updated` : ({ members: 'Member added', deposits: 'Deposit added', meals: 'Meal logged', groceries: 'Purchase added' })[type]);
      focusRecordAction(type, record?.id);
    });
  });
}

function openDelete(type, record) {
  const label = recordLabels[type];
  let details;
  if (type === 'members') details = [['Name', record.name], ['Phone', record.phone || '—']];
  else if (type === 'meals') details = [['Date', dateText(record.date)], ['Slot', record.slot], ['What was cooked', record.dish]];
  else details = [['Date / time', dateText(record.date, true)], ['Member', memberName(record.memberId)], ['Amount', money(record.amount)], ...(type === 'groceries' ? [['Items / note', record.note]] : [])];
  openDrawer(`Delete ${label}?`, `<form class="drawer-form" id="delete-form"><div class="drawer-fields"><dl class="delete-details">${details.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></div><div class="drawer-footer"><p class="form-status" role="status"></p><div class="form-actions"><button type="button" class="button secondary btn btn--secondary" data-cancel>Cancel</button><button type="submit" class="button danger btn">Delete ${label}</button></div></div></form>`);
  drawer.querySelector('[data-cancel]').addEventListener('click', () => drawer.close());
  drawer.querySelector('[data-cancel]').focus();
  drawer.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearErrors(form);
    await submitForm(form, async () => {
      data = await api(`${type}/${record.id}`, {}, 'DELETE');
      if (type === 'members' && filter === String(record.id)) filter = '';
      drawer.close();
      renderShell();
      notify(`${label[0].toUpperCase() + label.slice(1)} deleted`);
      document.querySelector('#add-action').focus();
    });
  });
}

function openHistory(id) {
  const member = calculateBalances(data).rows.find((entry) => entry.id === id);
  const entries = memberHistory(data, id);
  openDrawer(member.name, `<div class="history-content"><div class="history-summary"><div><span>Deposited</span><strong>${money(member.deposited)}</strong></div><div><span>Meals</span><strong>${number(member.meals)}</strong></div><div><span>Balance</span><strong class="${balanceClass(member.balance)}">${signedMoney(member.balance)}</strong></div></div><div class="history-list">${entries.map((entry) => `<div class="history-entry"><span class="history-icon">${icon(entry.kind === 'deposit' ? 'deposits' : 'meals')}</span><div><strong>${entry.kind === 'deposit' ? 'Deposit' : esc(entry.dish)}</strong><span>${dateText(entry.date, entry.kind === 'deposit')}${entry.kind === 'meal' ? ` · ${esc(entry.slot)}` : ''}</span></div><strong class="history-amount ${entry.kind === 'deposit' ? 'positive' : 'muted'}">${entry.kind === 'deposit' ? `+${money(entry.amount)}` : `${number(entry.units)} ${entry.units === 1 ? 'meal' : 'meals'}`}</strong></div>`).join('') || '<p class="history-empty">No history yet</p>'}</div></div>`);
}

function clearErrors(form) {
  form.querySelectorAll('.field-error, .form-status').forEach((element) => { element.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((element) => { element.removeAttribute('aria-invalid'); element.removeAttribute('aria-describedby'); });
}
function formError(form, message, fieldName) {
  const fieldElement = fieldName && [...form.querySelectorAll('[data-field]')].find((element) => element.dataset.field === fieldName);
  if (fieldElement) {
    const error = fieldElement.querySelector(':scope > .field-error');
    const input = fieldElement.querySelector('input, select, textarea') || fieldElement.querySelector('button');
    error.textContent = message;
    if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); input.focus(); }
    else form.querySelector('.form-status').textContent = message;
  } else form.querySelector('.form-status').textContent = message;
}
async function submitForm(form, callback) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try { await callback(); }
  catch (error) { formError(form, error.message, error.field); }
  finally { button.disabled = false; form.removeAttribute('aria-busy'); }
}

drawer.addEventListener('click', (event) => {
  if (event.target !== drawer) return;
  const rect = drawer.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) drawer.close();
});
drawer.addEventListener('close', () => {
  document.body.classList.remove('drawer-is-open');
  if (lastFocus?.isConnected) lastFocus.focus();
});
window.addEventListener('popstate', () => { if (drawer.open) drawer.close(); renderRoute(); });
document.addEventListener('keydown', (event) => {
  if (!app.classList.contains('menu-open')) return;
  if (event.key === 'Escape') return setMenu(false);
  if (event.key === 'Tab') {
    const controls = [...document.querySelector('.sidebar').querySelectorAll('a, button')].filter((element) => element.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.matchMedia('(min-width: 901px)').addEventListener('change', (event) => {
  if (event.matches && app.classList.contains('menu-open')) setMenu(false);
});

async function start() {
  try {
    session = await api('session');
    if (session.authenticated) data = await api('data');
    renderRoute();
  } catch (error) {
    app.className = 'connection-state';
    app.innerHTML = `<main id="content"><p>${esc(error.message)}</p><button class="button primary btn btn--primary" id="retry">Try again</button></main>`;
    document.querySelector('#retry').addEventListener('click', start);
    app.removeAttribute('aria-busy');
  }
}
start();
