import { markdown } from './markdown.js';

export const labels = {
  dashboard: 'Обзор',
  agents: 'ИИ-специалисты',
  workspace: 'Рабочее пространство',
  projects: 'Проекты',
  documents: 'База знаний',
  history: 'История',
  settings: 'Настройки',
};

const agentInitials = {
  analytic: 'АН', strategist: 'СТ', researcher: 'ИС', auditor: 'АУ', coordinator: 'КО',
};

export const agents = Object.fromEntries(Array.from(document.querySelectorAll('main .agent-card'), card => {
  const id = card.dataset.agent;
  const image = card.querySelector('img');
  return [id, {
    id,
    name: card.querySelector('h3').textContent.trim(),
    specialty: card.querySelector('.agent-card-copy p').textContent.trim(),
    description: card.querySelector('.agent-description').textContent.trim(),
    src: image.getAttribute('src'),
    alt: image.alt,
    initials: agentInitials[id],
  }];
}));

const dateShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dateFull = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function formatDate(value, formatter = dateFull) {
  if (!value || Number.isNaN(new Date(value).valueOf())) return '—';
  return formatter.format(new Date(value)).replace(/\s+г\.$/, '');
}

export function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

export function action(title, name, className = 'button-secondary', data = {}) {
  const button = el('button', className, title);
  button.type = 'button';
  button.dataset.action = name;
  Object.assign(button.dataset, data);
  return button;
}

function set(node, selector, value) {
  node.querySelector(selector).textContent = value;
}

function dynamicText(node, value) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) child.remove();
  }
  node.append(document.createTextNode(value));
}

function capital(word) {
  return word.charAt(0).toLocaleUpperCase('ru-RU') + word.slice(1);
}

export function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2)
    .map(word => Array.from(word)[0]?.toLocaleUpperCase('ru-RU')).join('') || 'ОБ';
}

function count(n, forms) {
  const tens = n % 100;
  const unit = n % 10;
  const index = tens >= 11 && tens <= 14 ? 2 : unit === 1 ? 0 : unit >= 2 && unit <= 4 ? 1 : 2;
  return `${n} ${forms[index]}`;
}

const analyses = n => count(n, ['анализ', 'анализа', 'анализов']);
const records = n => count(n, ['запись', 'записи', 'записей']);

const statuses = {
  running: ['В работе', 'in-progress'],
  pending: ['Ожидает', 'in-progress'],
  completed: ['Завершено', 'completed'],
  failed: ['Ошибка', 'needs-review'],
  error: ['Ошибка', 'needs-review'],
  cancelled: ['Прервано', 'needs-review'],
};
const statusText = status => statuses[status]?.[0] || 'Диалог';
const agentName = id => agents[id]?.name || labels.workspace;

function row(name) {
  return document.querySelector(`#row-${name}`).content.firstElementChild.cloneNode(true);
}

function signIn(message) {
  const p = el('p', 'office-empty');
  p.append(document.createTextNode(message + ' '), action('Войти', 'account', 'text-link'));
  return p;
}

function empty(container, state, own, guest = 'Войдите в аккаунт, чтобы открыть материалы.') {
  if (state.dataLoading) {
    container.append(el('p', 'office-empty', 'Загружаем рабочее пространство…'));
  } else if (state.loadError) {
    const notice = el('p', 'office-empty', state.loadError + ' ');
    notice.append(action('Повторить', 'refresh-state', 'text-link'));
    container.append(notice);
  } else {
    container.append(state.data.user ? el('p', 'office-empty', own) : signIn(guest));
  }
}

export function renderShell(state) {
  const user = state.data.user;
  const app = document.querySelector('.office-app');
  const header = document.querySelector('.topbar');
  const sidebar = document.querySelector('.sidebar');
  app.classList.toggle('office-compact', !!state.data.settings?.compact);
  set(sidebar, '.sidebar-user .avatar', user ? initials(user.name) : 'ОБ');
  set(sidebar, '.sidebar-user strong', user?.name || 'Войти');
  set(sidebar, '.sidebar-user small', user ? 'Личный аккаунт' : 'Офис баланса');
  set(header, '.profile-button .avatar', user ? initials(user.name) : 'ОБ');
  set(header, '.profile-button .profile-name', user?.name || 'Войти');
  header.querySelector('.profile-button').setAttribute('aria-label', user ? 'Настройки учётной записи' : 'Войти');
  set(header, '.breadcrumb strong', labels[state.view]);
  header.querySelector('.notification-dot').hidden = !state.unread || !state.data.settings?.notifications;
  for (const button of sidebar.querySelectorAll('.nav-item')) {
    const current = button.dataset.view === state.view;
    button.classList.toggle('nav-item-active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const active = state.data.threads.filter(thread => ['pending', 'running'].includes(thread.status)).length;
  const badge = sidebar.querySelector('.nav-count');
  badge.hidden = !active;
  badge.textContent = active;
  const recentProjects = sidebar.querySelector('.recent-project-list');
  recentProjects.replaceChildren(...state.data.projects.slice(0, 2).map((project, index) => {
    const button = action('', 'project-open', 'recent-project', { id: project.id });
    const mark = el('span', `project-mark ${index ? 'mark-blue' : 'mark-sand'}`, initials(project.name));
    button.append(mark, el('span', '', project.name));
    return button;
  }));
}

function report(thread, type = 'report-row') {
  const item = row(type);
  const history = type === 'history-row';
  const main = history ? '.history-main' : '.report-main';
  item.dataset.action = 'thread-open';
  item.dataset.id = thread.id;
  set(item, `${main} strong`, thread.title);
  set(item, `${main} small`, `${agentName(thread.agentId)} · ${statusText(thread.status)}`);
  set(item, history ? '.history-date' : '.report-date', formatDate(thread.updatedAt));
  return item;
}

function task(thread) {
  const item = row('task-row');
  set(item, '.task-row-title strong', thread.title);
  item.querySelector('.task-row-title strong').replaceWith(action(thread.title, 'thread-open', 'office-row-link', { id: thread.id }));
  const status = item.querySelector('.status-label');
  status.className = `status-label status-${statuses[thread.status]?.[1] || 'in-progress'}`;
  status.append(el('i'), document.createTextNode(statusText(thread.status)));
  item.querySelector('.task-row-meta').append(el('span', '', agentName(thread.agentId)), el('span', '', formatDate(thread.updatedAt)));
  return item;
}

export function renderAvailability(main, state) {
  if (state.dataLoading || state.data.aiConfigured) return;
  for (const badge of main.querySelectorAll('.agent-availability')) {
    dynamicText(badge, 'Не подключён');
    badge.classList.add('office-unavailable');
  }
}

export function renderDashboard(main, state) {
  dynamicText(main.querySelector('.page-heading .eyebrow'), capital(formatDate(new Date(), weekday)));
  const input = main.querySelector('#task-input');
  input.value = state.dashboard.text;
  input.maxLength = 12000;
  main.querySelector('.task-panel select').value = state.dashboard.agent;
  const active = state.data.threads.filter(thread => ['running', 'pending', 'failed', 'error'].includes(thread.status));
  const finished = state.data.threads.filter(thread => thread.status === 'completed');
  const tasks = main.querySelector('.task-list');
  const results = main.querySelector('.report-list');
  if (active.length) tasks.append(...active.slice(0, 3).map(task));
  else empty(tasks, state, 'Активных задач нет.');
  if (finished.length) results.append(...finished.slice(0, 3).map(thread => report(thread)));
  else empty(results, state, 'Завершённые анализы появятся здесь.');
  if (state.data.user) {
    const summary = main.querySelector('.reports-panel .panel-title-row .section-kicker');
    summary.textContent = `Завершено ${analyses(finished.length)}`;
  }
  renderAttachments(main, 'dashboard', state);
  renderAvailability(main, state);
  updateComposerButtons(main, state);
}

export function renderProjects(main, state) {
  const projects = state.data.projects;
  set(main, '.content-toolbar .inline-filter span', count(projects.length, ['проект', 'проекта', 'проектов']));
  const grid = main.querySelector('.projects-grid');
  const selection = projects.find(item => item.id === state.project) || projects[0];
  projects.forEach((project, index) => {
    const item = row('project-card');
    item.classList.toggle('project-card-active', project.id === selection?.id);
    item.dataset.action = 'project-open';
    item.dataset.id = project.id;
    const quantity = state.data.threads.filter(thread => thread.projectId === project.id).length;
    set(item, '.project-mark', initials(project.name));
    item.querySelector('.project-mark').classList.replace('mark-0', `mark-${index % 3}`);
    set(item, '.section-kicker', analyses(quantity));
    set(item, 'h2', project.name);
    set(item, 'p:not(.section-kicker)', project.description || 'Рабочие диалоги и результаты');
    dynamicText(item.querySelector('.project-card-footer span'), formatDate(project.updatedAt));
    grid.append(item);
  });
  if (!projects.length) {
    grid.classList.add('office-single-column');
    empty(grid, state, 'Создайте проект, чтобы собрать связанные диалоги в одном месте.');
    return;
  }

  const activity = main.querySelector('.project-activity');
  activity.hidden = false;
  const threads = state.data.threads.filter(thread => thread.projectId === selection.id);
  set(activity, 'h2', selection.name);
  set(activity, '.small-count', analyses(threads.length));
  const list = activity.querySelector('.report-list');
  if (threads.length) list.append(...threads.map(thread => report(thread)));
  else list.append(el('p', 'office-empty', 'В этом проекте ещё нет диалогов.'));
  const actions = el('div', 'office-panel-actions');
  actions.append(
    action('Начать анализ', 'new-chat', 'button-primary', { project: selection.id }),
    action('Изменить', 'project-edit', 'button-secondary', { id: selection.id }),
    action('Удалить', 'project-delete', 'text-link office-danger', { id: selection.id }),
  );
  activity.append(actions);
}

const sizeFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

function fileSize(size) {
  if (size >= 1024 * 1024) return `${sizeFormat.format(size / 1024 / 1024)} МБ`;
  if (size >= 1024) return `${sizeFormat.format(size / 1024)} КБ`;
  return `${size} Б`;
}

export function fileType(file) {
  return /\.([^.]+)$/.exec(file.name)?.[1].toUpperCase() || 'ФАЙЛ';
}

export function renderDocuments(main, state) {
  const files = state.data.documents.filter(file => !state.documentFilter || fileType(file) === state.documentFilter);
  const filter = main.querySelector('.knowledge-filter');
  const icons = Array.from(filter.querySelectorAll('svg'));
  filter.replaceChildren(icons[0], document.createTextNode(state.documentFilter || 'Все коллекции'), icons[1]);
  const list = main.querySelector('.knowledge-list');
  if (!files.length) empty(list, state, state.documentFilter ? 'В этой коллекции пока нет материалов.' : 'Загрузите PDF, DOCX, TXT, CSV или изображение.');
  for (const file of files) {
    const item = row('document-row');
    set(item, '.knowledge-file-name strong', file.name);
    set(item, '.knowledge-file-name small', `${fileSize(file.size)} · ${formatDate(file.createdAt, dateShort)}`);
    set(item, '.knowledge-category', fileType(file));
    const box = item.querySelector('.knowledge-file-name');
    const link = el('a', 'office-row-link', file.name);
    link.href = `/api/documents/${encodeURIComponent(file.id)}`;
    link.download = file.name;
    box.querySelector('strong').replaceChildren(link);
    const button = item.querySelector('button');
    button.dataset.action = 'document-actions';
    button.dataset.id = file.id;
    button.setAttribute('aria-label', `Действия с документом ${file.name}`);
    list.append(item);
  }
  if (state.uploading.library) main.querySelector('.knowledge-banner label').classList.add('office-busy');
}

export function renderHistory(main, state) {
  const cutoff = Date.now() - state.historyDays * 86_400_000;
  const filtered = state.data.threads.filter(thread => !state.historyDays || Date.parse(thread.updatedAt) >= cutoff);
  set(main, '.content-toolbar .inline-filter span', records(filtered.length));
  const button = main.querySelector('.knowledge-filter');
  const suffix = button.querySelectorAll('svg')[1];
  dynamicText(button, state.historyDays ? `Последние ${state.historyDays} дней` : 'За всё время');
  button.append(suffix);

  const panel = main.querySelector('.history-panel');
  if (!filtered.length) {
    empty(panel, state, 'За этот период нет записей.');
    return;
  }
  const groups = new Map();
  for (const thread of filtered) {
    const month = capital(formatDate(thread.updatedAt, monthYear));
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(thread);
  }
  for (const [month, threads] of groups) {
    const heading = el('div', 'history-date-group');
    heading.append(el('span', '', month), el('span', '', records(threads.length)));
    panel.append(heading, ...threads.map(thread => report(thread, 'history-row')));
  }
}

const monthYear = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });

export function renderSettings(main, state) {
  const user = state.data.user;
  if (!user) {
    const content = main.querySelector('.settings-content');
    for (const section of content.querySelectorAll('section')) section.hidden = true;
    empty(content, state, '', 'Войдите, чтобы изменить настройки.');
    main.querySelector('.settings-nav').hidden = true;
    return;
  }
  set(main, '.profile-settings-card .avatar', initials(user.name));
  set(main, '.profile-settings-card strong', user.name);
  set(main, '.profile-email', user.email);
  main.querySelector('.profile-settings-card > div').append(action('Выйти', 'logout', 'text-link office-logout'));
  const options = main.querySelector('#model-setting');
  for (const model of state.data.models) options.add(new Option(model.label, model.id));
  options.value = state.data.settings.model || state.data.models[0]?.id || '';
  options.disabled = options.options.length === 0;
  for (const toggle of main.querySelectorAll('[data-setting]')) {
    const enabled = !!state.data.settings[toggle.dataset.setting];
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.classList.toggle('switch-on', enabled);
  }
  if (!state.data.aiConfigured) {
    main.querySelector('#preferences').append(el('p', 'office-empty',
      'Gemini ещё не подключён. Для запуска администратору нужно настроить GEMINI_API_KEY на сервере.'));
  }
}

export function renderAttachments(main, scope, state) {
  const tray = main.querySelector(`[data-attachments="${scope}"]`);
  if (!tray) return;
  const values = state[scope].documents;
  const ready = values.map(id => state.data.documents.find(item => item.id === id)).filter(Boolean);
  const busy = state.uploading[scope];
  tray.hidden = !busy && !ready.length;
  tray.replaceChildren(...ready.map(item => {
    const button = action(item.name + ' ×', 'attachment-remove', 'composer-file office-file-chip', { scope, id: item.id });
    button.setAttribute('aria-label', `Убрать файл ${item.name}`);
    return button;
  }));
  if (busy) tray.append(el('span', 'office-progress-label', 'Загружаем файлы…'));
}

export function updateComposerButtons(main, state) {
  const dashboardStart = main.querySelector('[data-action=dashboard-start]');
  if (dashboardStart) dashboardStart.disabled = !state.dashboard.text.trim() && !state.dashboard.documents.length || state.uploading.dashboard;
  const send = main.querySelector('[data-action=send]');
  if (send) {
    const { text, documents } = state.workspace;
    send.disabled = !text.trim() && !documents.length || state.uploading.workspace || state.running || state.workspace.loading
      || (state.data.user && !state.data.aiConfigured);
  }
}

function workspaceModel(state) {
  const selected = state.data.models.find(model => model.id === state.data.settings?.model) || state.data.models[0];
  return selected?.label || 'Gemini';
}

function workspaceDetail(main, state) {
  const { workspace } = state;
  const aside = main.querySelector('.aside-info-card');
  const rows = aside.querySelectorAll(':scope > div');
  set(rows[0], 'strong', workspace.thread ? formatDate(workspace.thread.createdAt) : 'Новый диалог');
  const project = state.data.projects.find(project => project.id === workspace.projectId);
  const choose = rows[1].querySelector('button');
  const icon = choose.querySelector('svg');
  choose.replaceChildren(project?.name || 'Добавить в проект', icon);
  const used = new Set(workspace.messages.flatMap(message => message.documents?.map(doc => doc.id) || []));
  for (const id of workspace.documents) used.add(id);
  set(rows[2], 'strong', used.size ? count(used.size, ['документ', 'документа', 'документов']) : 'Не добавлены');
}

export function renderWorkspace(main, state) {
  const workspace = state.workspace;
  const agent = agents[workspace.agent] || agents.strategist;
  set(main, '.page-heading h1', agent.name);
  set(main, '.page-heading .page-subtitle', agent.specialty);
  set(main, '.workspace-agent-picker .mini-agent-mark', agent.initials);
  set(main, '.workspace-agent-picker span:nth-child(2)', agent.name);
  const model = workspaceModel(state);
  dynamicText(main.querySelector('.session-label'), model);
  set(main, '.composer-context strong', model);
  const intro = main.querySelector('.aside-agent-card');
  const image = intro.querySelector('img');
  image.src = agent.src;
  image.alt = agent.alt;
  set(intro, 'h2', agent.name);
  set(intro, 'p:not(.section-kicker)', agent.description);
  dynamicText(intro.querySelector('.aside-specialty'), agent.specialty);
  const sourcesButton = action('Из базы знаний', 'choose-documents', 'office-composer-link');
  main.querySelector('.composer-actions .attach-round').after(sourcesButton);
  const toolbar = main.querySelector('.conversation-toolbar');
  const newChat = action('Новый диалог', 'workspace-new', 'office-dialog-new');
  toolbar.querySelector('.toolbar-spacer').before(newChat);
  const text = main.querySelector('#agent-composer');
  text.value = workspace.text;
  text.maxLength = 12000;
  text.placeholder = `Задайте вопрос для специалиста «${agent.name}»…`;
  const notice = main.querySelector('.composer-disclaimer');
  if (state.data.user && !state.data.aiConfigured) notice.textContent = 'Gemini не подключён. Обратитесь к администратору рабочего пространства.';
  renderAttachments(main, 'workspace', state);
  renderMessages(main, state);
  workspaceDetail(main, state);
  updateComposerButtons(main, state);
}

export function renderMessages(main, state) {
  const list = main.querySelector('.conversation-scroll');
  if (!list) return;
  const { workspace } = state;
  const agent = agents[workspace.agent] || agents.strategist;
  const date = el('div', 'conversation-date');
  date.append(el('span'), formatDate(workspace.thread?.createdAt || new Date(), dateShort), el('span'));
  const expanded = new Set(Array.from(list.querySelectorAll('details[open][data-step]'), item => item.dataset.step));
  list.replaceChildren(date);
  if (workspace.loading) {
    list.append(el('p', 'office-progress-label', 'Открываем диалог…'));
    return;
  }
  if (!workspace.messages.length) {
    const greet = row('assistant-message');
    set(greet, '.message-author strong', agent.name);
    set(greet, '.message-author span', 'Gemini');
    set(greet, '.message-content p', agent.id === 'coordinator'
      ? 'Опишите задачу. Я распределю вопросы между специалистами и объединю их выводы.'
      : `Здравствуйте. Я — ${agent.name.toLocaleLowerCase('ru-RU')}. ${agent.description}`);
    list.append(greet);
  }
  for (const message of workspace.messages) {
    list.append(messageView(message, agent, state.data.documents, !!state.running, expanded));
  }
  if (workspace.error) {
    const alert = el('p', 'office-form-error', workspace.error);
    alert.role = 'alert';
    list.append(alert);
  }
}

function messageView(message, agent, available, running, expanded) {
  const item = row('assistant-message');
  set(item, '.message-author strong', message.role === 'user' ? 'Вы' : agent.name);
  set(item, '.message-author span', message.role === 'assistant' ? 'Gemini' : '');
  const content = item.querySelector('.message-content');
  if (message.role === 'user') {
    item.classList.replace('assistant-message', 'message-user');
    item.classList.add('office-user-message');
    item.querySelector('.message-avatar').replaceChildren('ВЫ');
    set(content, 'p', message.content);
    content.querySelector('p').classList.add('office-user-copy');
    for (const doc of message.documents || []) {
      if (available.some(item => item.id === doc.id)) {
        const link = el('a', 'composer-file', doc.name);
        link.href = `/api/documents/${encodeURIComponent(doc.id)}`;
        link.download = doc.name;
        content.append(link);
      } else {
        content.append(el('span', 'composer-file', doc.name));
      }
    }
    return item;
  }

  content.classList.add('office-markdown');
  content.replaceChildren();
  if (message.steps?.length) {
    const steps = el('div', 'office-agent-stages');
    steps.append(el('p', 'office-stage-heading', 'Работа специалистов'));
    for (const step of message.steps) {
      const summaryText = `${agentName(step.agentId)} · ${statusText(step.status)}`;
      if (step.text) {
        const detail = el('details', 'office-stage');
        detail.dataset.step = `${message.id}:${step.agentId}`;
        detail.open = expanded.has(detail.dataset.step);
        detail.append(el('summary', '', summaryText));
        const body = el('div', 'office-stage-body');
        body.append(markdown(step.text));
        detail.append(body);
        steps.append(detail);
      } else {
        steps.append(el('p', 'office-stage', summaryText));
      }
    }
    content.append(steps);
  }
  if (message.content) content.append(markdown(message.content));
  if (message.status === 'running' && running) content.append(el('p', 'office-progress-label', 'Готовим ответ…'));
  if (['failed', 'error'].includes(message.status) && !running) content.append(el('p', 'office-progress-label', 'Анализ не завершён.'));
  if (message.status === 'running' && !running) content.append(el('p', 'office-progress-label', 'Анализ выполняется. Обновите диалог позже.'));
  if (message.status === 'completed' && message.content) {
    const tools = el('div', 'office-message-tools');
    const payload = { id: message.id };
    tools.append(action('Скопировать', 'message-copy', 'text-link', payload), action('Экспорт Markdown', 'message-export', 'text-link', payload));
    content.append(tools);
  }
  return item;
}
