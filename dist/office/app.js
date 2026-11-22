import { OfficeApiError, request, streamChat, uploadFile } from './api.js';
import {
  action, agents, el, fileType, formatDate, labels, renderAttachments, renderAvailability, renderDashboard,
  renderDocuments, renderHistory, renderMessages, renderProjects, renderSettings, renderShell, renderWorkspace,
  updateComposerButtons,
} from './views.js';

const main = document.querySelector('main');
const dialog = document.querySelector('.office-dialog');
const toast = document.querySelector('.office-toast');
const dashboardTemplate = document.createDocumentFragment();
dashboardTemplate.append(...Array.from(main.childNodes, child => child.cloneNode(true)));
const renderers = {
  dashboard: renderDashboard, agents: renderAvailability, workspace: renderWorkspace,
  projects: renderProjects, documents: renderDocuments, history: renderHistory, settings: renderSettings,
};

const attachmentLimit = 4;
const uploadLimit = 3 * 1024 * 1024;
const agentDefault = 'strategist';
const emptyData = () => ({
  user: null, projects: [], documents: [], threads: [], settings: {}, models: [], aiConfigured: false,
});
const draft = () => ({ text: '', agent: agentDefault, documents: [] });
const freshWorkspace = (agent = agentDefault) => ({
  ...draft(), agent, thread: null, projectId: null, messages: [], error: '', loading: false,
});

const state = {
  view: 'dashboard', data: emptyData(), dataLoading: true, loadError: '',
  dashboard: draft(), workspace: freshWorkspace(), project: null, running: false,
  documentFilter: '', historyDays: 0, unread: false,
  uploading: { dashboard: false, workspace: false, library: false },
};

let toastTimer;
let chatFrame;
let pendingAccess;
let dataRequest;

function notify(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4_500);
}

function top() {
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function render(scroll = false) {
  renderShell(state);
  const template = state.view === 'dashboard' ? dashboardTemplate : document.querySelector(`#view-${state.view}`).content;
  main.replaceChildren(template.cloneNode(true));
  renderers[state.view](main, state);
  if (scroll) top();
}

function closeMobile() {
  document.querySelector('.sidebar').classList.remove('sidebar-open');
  document.querySelector('.mobile-scrim').hidden = true;
  document.querySelector('.mobile-menu-button').setAttribute('aria-expanded', 'false');
}

function openMobile() {
  document.querySelector('.sidebar').classList.add('sidebar-open');
  document.querySelector('.mobile-scrim').hidden = false;
  document.querySelector('.mobile-menu-button').setAttribute('aria-expanded', 'true');
  document.querySelector('.sidebar-close').focus();
}

function setRoute(view, id, replace) {
  const path = view === 'dashboard' ? '' : `#${view}${id ? '/' + encodeURIComponent(id) : ''}`;
  if (location.hash !== path) {
    const next = new URL(location.href);
    next.hash = path;
    if (replace) history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  }
}

function go(view, { scroll = true, updateRoute = true, replace = false } = {}) {
  closeMobile();
  state.view = view;
  const id = view === 'workspace' ? state.workspace.thread?.id : undefined;
  if (updateRoute) setRoute(view, id, replace);
  render(scroll);
}

async function refresh(renderView = true) {
  const marker = {};
  dataRequest = marker;
  try {
    const data = await request('/state');
    if (dataRequest !== marker) return;
    state.data = data;
    state.loadError = '';
  } catch (error) {
    if (dataRequest !== marker) return;
    state.loadError = error.message;
  } finally {
    if (dataRequest === marker) {
      state.dataLoading = false;
      if (renderView) render();
    }
  }
}

function readRoute() {
  const [key, identifier = ''] = location.hash.slice(1).split('/');
  const view = Object.hasOwn(labels, key) ? key : 'dashboard';
  try {
    return { view, id: decodeURIComponent(identifier) };
  } catch {
    return { view, id: '' };
  }
}

async function followRoute() {
  const { view, id } = readRoute();
  if (view === 'workspace' && id && id !== state.workspace.thread?.id) {
    await openThread(id, false);
  } else {
    go(view, { updateRoute: false });
  }
}

function showDialog(title, body, kicker = 'Офис баланса') {
  const panel = el('div', 'project-dialog office-dialog-panel');
  const close = action('×', 'dialog-close', 'icon-button office-dialog-close');
  close.setAttribute('aria-label', 'Закрыть');
  const heading = el('h2', '', title);
  heading.id = 'office-dialog-title';
  panel.append(close, el('p', 'section-kicker', kicker), heading, body);
  dialog.replaceChildren(panel);
  if (!dialog.open) dialog.showModal();
  (panel.querySelector('input, select, textarea') || close).focus();
}

function closeDialog() {
  if (dialog.open) dialog.close();
}

function formDialog(title, options) {
  const form = el('form', 'office-form');
  const error = el('p', 'office-form-error');
  error.role = 'alert';
  error.hidden = true;
  if (options.description) form.append(el('p', 'office-dialog-caption', options.description));
  for (const field of options.fields || []) {
    const control = field.type === 'textarea' ? el('textarea', 'office-control') : el('input', 'office-control');
    if (field.type !== 'textarea') control.type = field.type || 'text';
    control.id = `office-field-${field.name}`;
    control.name = field.name;
    control.value = field.value || '';
    control.required = !!field.required;
    if (field.max) control.maxLength = field.max;
    if (field.min) control.minLength = field.min;
    if (field.autocomplete) control.autocomplete = field.autocomplete;
    const label = el('label', 'office-field', field.label);
    label.htmlFor = control.id;
    label.append(control);
    form.append(label);
  }
  const buttons = el('div', 'office-form-actions');
  if (options.extra) buttons.append(options.extra);
  const submit = el('button', 'button-primary', options.submit);
  submit.type = 'submit';
  buttons.append(submit);
  form.append(error, buttons);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      await options.onSubmit(Object.fromEntries(new FormData(form)));
    } catch (problem) {
      error.textContent = problem.message || 'Не удалось выполнить действие.';
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  showDialog(title, form, options.kicker);
}

function requireUser(next) {
  if (state.data.user) return true;
  pendingAccess = next;
  authDialog('login');
  return false;
}

function authDialog(mode) {
  const signup = mode === 'signup';
  const fields = [
    { name: 'email', label: 'Электронная почта', type: 'email', required: true, max: 254, autocomplete: 'email' },
    { name: 'password', label: 'Пароль', type: 'password', required: true, min: signup ? 8 : undefined, max: 200, autocomplete: signup ? 'new-password' : 'current-password' },
  ];
  if (signup) fields.unshift({ name: 'name', label: 'Ваше имя', required: true, max: 100, autocomplete: 'name' });
  if (signup && state.data.registrationCodeRequired) fields.push({ name: 'registrationCode', label: 'Код приглашения', required: true, max: 128 });
  const switchMode = action(signup ? 'Уже есть аккаунт' : 'Создать аккаунт', 'auth-mode', 'text-link', { mode: signup ? 'login' : 'signup' });
  formDialog(signup ? 'Создать аккаунт' : 'Войти в офис', {
    fields,
    extra: switchMode,
    submit: signup ? 'Зарегистрироваться' : 'Войти',
    async onSubmit(data) {
      const { user } = await request('/auth', { method: 'POST', data: { action: mode, ...data } });
      const continuation = pendingAccess;
      pendingAccess = null;
      state.data.user = user;
      closeDialog();
      await refresh();
      notify(signup ? 'Аккаунт создан.' : 'Вы вошли в офис.');
      if (continuation) await continuation();
    },
  });
}

function account() {
  if (state.data.user) {
    go('settings');
    return;
  }
  pendingAccess = null;
  authDialog('login');
}

async function logout() {
  if (state.running) {
    notify('Дождитесь завершения текущего анализа.');
    return;
  }
  await request('/auth', { method: 'POST', data: { action: 'logout' } });
  state.data = emptyData();
  state.dashboard = draft();
  state.workspace = freshWorkspace();
  state.project = null;
  state.unread = false;
  await refresh(false);
  go('dashboard');
  notify('Вы вышли из аккаунта.');
}

function switchWorkspace(agent, options = {}) {
  if (state.running) {
    notify('Дождитесь завершения текущего анализа.');
    return;
  }
  state.workspace = { ...freshWorkspace(agents[agent] ? agent : agentDefault), ...options };
  go('workspace');
}

function startFromDashboard(forceCoordinator = false) {
  const { text, agent, documents } = state.dashboard;
  switchWorkspace(forceCoordinator || agent === 'all' ? 'coordinator' : agent, { text, documents: [...documents] });
  if (state.view === 'workspace') main.querySelector('#agent-composer').focus();
}

function toggleAgentPicker(button) {
  const toolbar = button.closest('.conversation-toolbar');
  const existing = toolbar.parentElement.querySelector('.agent-picker-popover');
  if (existing) {
    existing.remove();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  const picker = el('div', 'agent-picker-popover');
  for (const specialist of Object.values(agents)) {
    const choice = action('', 'new-chat', '', { agent: specialist.id, carry: 'true' });
    const info = el('span');
    info.append(specialist.name, el('small', '', specialist.specialty));
    choice.append(el('span', 'mini-agent-mark', specialist.initials), info);
    picker.append(choice);
  }
  toolbar.after(picker);
  button.setAttribute('aria-expanded', 'true');
  picker.firstElementChild.focus();
}

async function openThread(id, updateRoute = true) {
  if (state.running) {
    if (id === state.workspace.thread?.id) go('workspace');
    else notify('Дождитесь завершения текущего анализа.');
    return;
  }
  if (!requireUser(() => openThread(id, updateRoute))) return;
  const summary = state.data.threads.find(item => item.id === id);
  const workspace = { ...freshWorkspace(summary?.agentId), projectId: summary?.projectId || null, thread: summary || { id }, loading: true };
  state.workspace = workspace;
  go('workspace', { updateRoute });
  try {
    const { thread, messages } = await request(`/threads/${encodeURIComponent(id)}`);
    workspace.thread = thread;
    workspace.agent = thread.agentId;
    workspace.projectId = thread.projectId || null;
    workspace.messages = messages;
  } catch (error) {
    workspace.error = error.message;
    workspace.thread = null;
  } finally {
    workspace.loading = false;
    if (state.workspace === workspace && state.view === 'workspace') render();
  }
}

function previewMessage(workspace) {
  if (chatFrame) return;
  chatFrame = requestAnimationFrame(() => {
    chatFrame = null;
    if (state.view === 'workspace' && state.workspace === workspace) renderMessages(main, state);
  });
}

async function send() {
  const workspace = state.workspace;
  const text = workspace.text.trim();
  const documentIds = [...workspace.documents];
  if (state.running || state.uploading.workspace || workspace.loading || !text && !documentIds.length) return;
  if (!requireUser(send)) return;
  if (!state.data.aiConfigured) {
    notify('Gemini не подключён к серверу.');
    return;
  }

  const input = {
    text, documentIds, agentId: workspace.agent,
    requestId: crypto.randomUUID(), threadId: workspace.thread?.id,
    projectId: workspace.projectId || undefined,
  };
  const userMessage = {
    id: input.requestId, role: 'user', content: text, status: 'completed',
    documents: documentIds.map(id => state.data.documents.find(file => file.id === id)).filter(Boolean),
  };
  const output = { id: '', role: 'assistant', content: '', status: 'running', steps: [] };
  const oldMessages = [...workspace.messages];
  const newThread = !workspace.thread;
  let accepted = false;

  state.running = true;
  workspace.error = '';
  workspace.text = '';
  workspace.documents = [];
  workspace.messages.push(userMessage, output);
  render();
  if (state.view === 'workspace') main.querySelector('#agent-composer').focus();
  try {
    await streamChat(input, event => {
      if (event.type === 'start') {
        accepted = true;
        if (event.threadId) {
          const now = new Date().toISOString();
          workspace.thread = {
            id: event.threadId, title: text || 'Анализ документов', createdAt: now,
            ...workspace.thread,
            agentId: workspace.agent, projectId: workspace.projectId, status: 'running', updatedAt: now,
          };
          state.data.threads = [workspace.thread, ...state.data.threads.filter(item => item.id !== event.threadId)];
          if (newThread && state.view === 'workspace') setRoute('workspace', event.threadId, true);
          if (state.view === 'dashboard' || state.view === 'projects' || state.view === 'history') render();
          else renderShell(state);
        }
        output.id = event.messageId;
      }
      if (event.type === 'stage') {
        const stage = { agentId: event.agentId, status: event.status, text: event.text || '' };
        const index = output.steps.findLastIndex(item => item.agentId === event.agentId && item.status === 'running');
        if (index >= 0) output.steps.splice(index, 1, stage);
        else output.steps.push(stage);
      }
      if (event.type === 'delta') output.content += event.text;
      if (event.type === 'done') {
        output.id = event.messageId || output.id;
        output.content = event.text || output.content;
        output.status = 'completed';
        state.unread = !!state.data.settings.notifications;
      }
      previewMessage(workspace);
    });
    if (state.view !== 'workspace' && state.data.settings.notifications) notify('Анализ завершён.');
  } catch (error) {
    workspace.error = error.message;
    output.status = 'failed';
    if (!accepted) {
      workspace.messages = oldMessages;
      if (!workspace.text.trim()) workspace.text = text;
      workspace.documents = [...new Set([...documentIds, ...workspace.documents])].slice(0, attachmentLimit);
    }
    if (state.view !== 'workspace') notify(error.message);
    if (error instanceof OfficeApiError && error.status === 401) await refresh(false);
  } finally {
    state.running = false;
    await refresh(false);
    render();
  }
}

function projectDialog(project, context) {
  if (!requireUser(() => projectDialog(project, context))) return;
  formDialog(project ? 'Изменить проект' : 'Создать проект', {
    kicker: 'Проекты',
    fields: [
      { name: 'name', label: 'Название проекта', value: project?.name, required: true, max: 120 },
      { name: 'description', label: 'Описание', type: 'textarea', value: project?.description, max: 500 },
    ],
    submit: project ? 'Сохранить изменения' : 'Создать проект',
    async onSubmit(data) {
      const result = await request(project ? `/projects/${encodeURIComponent(project.id)}` : '/projects', {
        method: project ? 'PATCH' : 'POST', data,
      });
      state.project = result.project.id;
      closeDialog();
      await refresh(false);
      if (context === 'workspace') await attachProject(result.project.id);
      else go('projects', { scroll: !project });
      notify(project ? 'Проект обновлён.' : 'Проект создан.');
    },
  });
}

function confirmAction(title, description, verb, submit) {
  formDialog(title, { description, submit: verb, onSubmit: submit });
}

function deleteProject(id) {
  const project = state.data.projects.find(item => item.id === id);
  if (!project) return;
  confirmAction('Удалить проект?', `Проект «${project.name}» будет удалён. Диалоги останутся в истории.`, 'Удалить проект', async () => {
    await request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.project === id) state.project = null;
    if (state.workspace.projectId === id) state.workspace.projectId = null;
    closeDialog();
    await refresh();
    notify('Проект удалён.');
  });
}

function chooseProject() {
  if (!requireUser(chooseProject)) return;
  if (state.running || state.workspace.loading) {
    notify('Дождитесь завершения текущего анализа.');
    return;
  }
  const list = el('div', 'office-dialog-options');
  for (const project of state.data.projects) {
    const option = action(project.name, 'project-attach', 'button-secondary', { id: project.id });
    if (state.workspace.projectId === project.id) option.setAttribute('aria-current', 'true');
    list.append(option);
  }
  if (state.workspace.projectId) list.append(action('Отвязать проект', 'project-attach'));
  list.append(action('Новый проект', 'project-new', 'text-link', { context: 'workspace' }));
  showDialog('Добавить в проект', list, 'Диалог');
}

async function attachProject(id = null) {
  const workspace = state.workspace;
  if (workspace.thread?.id) {
    const { thread } = await request(`/threads/${encodeURIComponent(workspace.thread.id)}`, { method: 'PATCH', data: { projectId: id } });
    workspace.thread = thread;
    await refresh(false);
  }
  workspace.projectId = id;
  closeDialog();
  render();
  notify(id ? 'Диалог связан с проектом.' : 'Связь с проектом снята.');
}

async function loadFiles(scope, inputFiles) {
  const files = Array.from(inputFiles);
  if (!files.length || state.uploading[scope]) return;
  if (!requireUser(() => loadFiles(scope, files))) return;

  const target = scope === 'library' ? null : state[scope];
  const room = target ? attachmentLimit - target.documents.length : 8;
  if (files.length > room) {
    notify(target ? `До ${attachmentLimit} вложений на сообщение. Уберите лишние файлы.` : 'За один раз можно добавить до 8 файлов.');
    return;
  }
  state.uploading[scope] = true;
  render();

  const failures = [];
  let uploaded = 0;
  try {
    for (const file of files) {
      try {
        if (file.size > uploadLimit) throw new Error('Файл превышает 3 МБ.');
        const { document: entry } = await uploadFile(file);
        state.data.documents.unshift(entry);
        if (target) target.documents.push(entry.id);
        uploaded++;
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }
    await refresh(false);
  } finally {
    state.uploading[scope] = false;
    render();
  }
  if (failures.length) {
    const note = el('div', 'office-dialog-options');
    for (const description of failures) note.append(el('p', 'office-form-error', description));
    showDialog('Не удалось добавить все файлы', note, 'База знаний');
  } else if (uploaded) {
    notify(uploaded > 1 ? 'Файлы сохранены в базе знаний.' : 'Файл сохранён в базе знаний.');
  }
}

function chooseDocuments() {
  if (!requireUser(chooseDocuments)) return;
  const { documents } = state.data;
  if (!documents.length) {
    const block = el('div', 'office-dialog-options');
    block.append(el('p', 'office-dialog-caption', 'В базе знаний пока нет документов.'), action('Открыть базу знаний', 'navigate', 'button-primary', { view: 'documents' }));
    showDialog('Добавить из базы знаний', block, 'Источники');
    return;
  }
  const form = el('form', 'office-form');
  const options = el('div', 'office-choice-list');
  for (const file of documents) {
    const label = el('label', 'office-choice');
    const input = el('input');
    input.type = 'checkbox';
    input.name = 'document';
    input.value = file.id;
    input.checked = state.workspace.documents.includes(file.id);
    label.append(input, el('span', '', file.name));
    options.append(label);
  }
  const submit = el('button', 'button-primary', 'Применить');
  submit.type = 'submit';
  const note = el('p', 'office-form-error');
  note.hidden = true;
  note.role = 'alert';
  form.append(el('p', 'office-dialog-caption', `Выберите до ${attachmentLimit} файлов для анализа и сравнения.`), options, note, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const checked = new FormData(form).getAll('document');
    if (checked.length > attachmentLimit) {
      note.textContent = `Можно выбрать не больше ${attachmentLimit} файлов.`;
      note.hidden = false;
      return;
    }
    state.workspace.documents = checked;
    closeDialog();
    render();
  });
  showDialog('Добавить из базы знаний', form, 'Источники');
}

function documentActions(id) {
  const file = state.data.documents.find(entry => entry.id === id);
  if (!file) return;
  const block = el('div', 'office-dialog-options');
  const link = el('a', 'button-secondary', 'Скачать файл');
  link.href = `/api/documents/${encodeURIComponent(file.id)}`;
  link.download = file.name;
  block.append(
    action('Открыть для анализа', 'document-analyze', 'button-primary', { id }),
    link,
    action('Удалить из базы знаний', 'document-delete', 'text-link office-danger', { id }),
  );
  showDialog(file.name, block, 'База знаний');
}

function deleteDocument(id) {
  const file = state.data.documents.find(entry => entry.id === id);
  if (!file) return;
  confirmAction('Удалить документ?', `Файл «${file.name}» станет недоступен для новых запросов.`, 'Удалить документ', async () => {
    await request(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    for (const scope of ['workspace', 'dashboard']) {
      state[scope].documents = state[scope].documents.filter(entry => entry !== id);
    }
    closeDialog();
    await refresh();
    notify('Документ удалён.');
  });
}

function documentFilter() {
  const list = el('div', 'office-dialog-options');
  list.append(action('Все коллекции', 'set-document-filter', 'button-secondary', { type: '' }));
  const types = new Set(state.data.documents.map(fileType));
  for (const type of types) list.append(action(type, 'set-document-filter', 'button-secondary', { type }));
  showDialog('Коллекции документов', list, 'База знаний');
}

function historyFilter() {
  const list = el('div', 'office-dialog-options');
  for (const [days, title] of [[0, 'За всё время'], [7, 'Последние 7 дней'], [30, 'Последние 30 дней']]) {
    const button = action(title, 'set-history-filter', 'button-secondary', { days });
    if (days === state.historyDays) button.setAttribute('aria-current', 'true');
    list.append(button);
  }
  showDialog('Период истории', list, 'История');
}

async function updateSettings(data) {
  await request('/settings', { method: 'PATCH', data });
  await refresh();
  notify('Настройки сохранены.');
}

function editProfile() {
  if (!requireUser(editProfile)) return;
  formDialog('Изменить профиль', {
    fields: [{ name: 'name', label: 'Ваше имя', value: state.data.user.name, required: true, max: 100 }],
    submit: 'Сохранить профиль',
    async onSubmit(data) {
      await updateSettings(data);
      closeDialog();
    },
  });
}

function privacy() {
  const text = el('div', 'office-dialog-options');
  text.append(el('p', 'office-dialog-caption', 'Проекты, история и файлы доступны через ваш аккаунт. При отправке задачи Gemini получает запрос и файлы, выбранные для анализа.'));
  showDialog('Приватное пространство', text);
}

function help() {
  const body = el('div', 'office-dialog-options');
  body.append(
    el('p', 'office-dialog-caption', 'Откройте специалиста и опишите задачу. Координатор распределяет подзадачи между несколькими специалистами. В одном запросе можно сопоставить до четырёх файлов размером до 3 МБ каждый.'),
    action('Открыть специалистов', 'navigate', 'button-primary', { view: 'agents' }),
    action('Открыть базу знаний', 'navigate', 'button-secondary', { view: 'documents' }),
  );
  showDialog('Справочный центр', body);
}

function notifications() {
  const list = el('div', 'office-dialog-options');
  state.unread = false;
  renderShell(state);
  if (!state.data.user) {
    list.append(action('Войти в офис', 'account', 'button-primary'));
  } else if (!state.data.settings.notifications) {
    list.append(el('p', 'office-dialog-caption', 'Уведомления отключены в настройках.'), action('Открыть настройки', 'navigate', 'button-secondary', { view: 'settings' }));
  } else {
    const results = state.data.threads.filter(thread => thread.status === 'completed').slice(0, 5);
    if (!results.length) list.append(el('p', 'office-dialog-caption', 'Завершённых анализов пока нет.'));
    for (const thread of results) {
      list.append(action(`${thread.title} · ${formatDate(thread.updatedAt)}`, 'thread-open', 'button-secondary', { id: thread.id }));
    }
  }
  showDialog('Уведомления', list);
}

function showSearch(value = '') {
  const wrap = el('div', 'office-form');
  const field = el('input', 'office-control');
  field.type = 'search';
  field.value = value;
  field.setAttribute('aria-label', 'Поиск по офису');
  field.placeholder = 'Проекты, документы, диалоги…';
  const results = el('div', 'office-dialog-options office-search-results');
  function fill() {
    const query = field.value.trim().toLocaleLowerCase('ru-RU');
    const contains = item => item.toLocaleLowerCase('ru-RU').includes(query);
    const matches = [];
    for (const [view, name] of Object.entries(labels)) {
      if (!query || contains(name)) matches.push(action(name, 'navigate', 'button-secondary', { view }));
    }
    if (query) {
      for (const project of state.data.projects) if (contains(project.name)) matches.push(action(`${project.name} · Проект`, 'project-open', 'button-secondary', { id: project.id }));
      for (const file of state.data.documents) if (contains(file.name)) matches.push(action(`${file.name} · Документ`, 'document-actions', 'button-secondary', { id: file.id }));
      for (const thread of state.data.threads) if (contains(thread.title)) matches.push(action(`${thread.title} · Диалог`, 'thread-open', 'button-secondary', { id: thread.id }));
    }
    results.replaceChildren(...matches.slice(0, 20));
    if (!matches.length) results.append(el('p', 'office-dialog-caption', 'Ничего не найдено.'));
  }
  field.addEventListener('input', fill);
  fill();
  wrap.append(field, results);
  showDialog('Поиск по офису', wrap);
}

async function copyMessage(id) {
  const message = state.workspace.messages.find(item => item.id === id);
  if (!message?.content) return;
  try {
    await navigator.clipboard.writeText(message.content);
    notify('Ответ скопирован.');
  } catch {
    notify('Не удалось скопировать ответ. Можно скачать Markdown.');
  }
}

function exportMessage(id) {
  const message = state.workspace.messages.find(item => item.id === id);
  if (!message?.content) return;
  const title = state.workspace.thread?.title || 'Ответ Офиса баланса';
  const blob = new Blob([`# ${title}\n\n`, message.content, '\n'], { type: 'text/markdown;charset=UTF-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').trim().slice(0, 90) || 'Ответ'}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const actions = {
  account,
  'auth-mode': button => authDialog(button.dataset.mode),
  logout,
  navigate: button => { closeDialog(); go(button.dataset.view); },
  'mobile-open': openMobile,
  'mobile-close': button => { closeMobile(); if (button !== document.querySelector('.mobile-scrim')) document.querySelector('.mobile-menu-button').focus(); },
  'dialog-close': closeDialog,
  'workspace-details': () => { if (state.data.user) privacy(); else account(); },
  'refresh-state': () => refresh(),
  'open-file': button => document.getElementById(button.dataset.target).click(),
  'dashboard-start': () => startFromDashboard(),
  'dashboard-coordinator': () => startFromDashboard(true),
  'new-chat': button => {
    const carry = button.dataset.carry;
    const { text, documents, projectId } = state.workspace;
    closeDialog();
    switchWorkspace(button.dataset.agent || agentDefault, carry ? {
      text, documents: [...documents], projectId,
    } : { projectId: button.dataset.project || null });
  },
  'workspace-new': () => switchWorkspace(state.workspace.agent, { projectId: state.workspace.projectId }),
  'agent-picker': toggleAgentPicker,
  'thread-open': button => { closeDialog(); return openThread(button.dataset.id); },
  send,
  'project-new': button => projectDialog(null, button.dataset.context),
  'project-open': button => {
    closeDialog();
    state.project = button.dataset.id;
    go('projects', { scroll: state.view !== 'projects' });
  },
  'project-edit': button => projectDialog(state.data.projects.find(project => project.id === button.dataset.id)),
  'project-delete': button => deleteProject(button.dataset.id),
  'choose-project': chooseProject,
  'project-attach': button => attachProject(button.dataset.id || null),
  'choose-documents': chooseDocuments,
  'attachment-remove': button => {
    const { scope, id } = button.dataset;
    state[scope].documents = state[scope].documents.filter(entry => entry !== id);
    renderAttachments(main, scope, state);
    updateComposerButtons(main, state);
  },
  'document-actions': button => documentActions(button.dataset.id),
  'document-analyze': button => { closeDialog(); switchWorkspace('analytic', { documents: [button.dataset.id] }); },
  'document-delete': button => deleteDocument(button.dataset.id),
  'document-filter': documentFilter,
  'set-document-filter': button => { state.documentFilter = button.dataset.type; closeDialog(); render(); },
  'history-filter': historyFilter,
  'set-history-filter': button => { state.historyDays = Number(button.dataset.days); closeDialog(); render(); },
  'profile-edit': editProfile,
  'setting-toggle': button => {
    const setting = button.dataset.setting;
    return updateSettings({ [setting]: !state.data.settings[setting] });
  },
  'message-copy': button => copyMessage(button.dataset.id),
  'message-export': button => exportMessage(button.dataset.id),
  notifications,
  help,
  privacy,
};

document.addEventListener('click', async event => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) {
    const search = event.target.closest('.global-search');
    if (search && !search.querySelector('input').getClientRects().length) {
      event.preventDefault();
      showSearch();
      return;
    }
    const settingsLink = event.target.closest('.settings-nav a');
    if (settingsLink) {
      event.preventDefault();
      document.getElementById(settingsLink.hash.slice(1)).scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (event.target === dialog) closeDialog();
    return;
  }
  const handler = actions[trigger.dataset.action];
  if (!handler) return;
  event.preventDefault();
  try {
    await handler(trigger);
  } catch (error) {
    notify(error.message || 'Не удалось выполнить действие.');
    if (error instanceof OfficeApiError && error.status === 401) await refresh();
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'task-input') state.dashboard.text = event.target.value;
  else if (event.target.id === 'agent-composer') state.workspace.text = event.target.value;
  else return;
  updateComposerButtons(main, state);
});

document.addEventListener('change', async event => {
  const target = event.target;
  if (target.matches('.task-panel select')) {
    state.dashboard.agent = target.value;
    return;
  }
  if (target.dataset.upload) {
    const files = [...target.files];
    target.value = '';
    await loadFiles(target.dataset.upload, files);
    return;
  }
  if (target.id === 'model-setting') {
    target.disabled = true;
    try {
      await updateSettings({ model: target.value });
    } catch (error) {
      notify(error.message);
      render();
    }
  }
});

document.addEventListener('keydown', event => {
  const target = event.target;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    showSearch(document.querySelector('.global-search input').value);
  } else if (event.key === 'Enter' && !event.isComposing && target.matches('.global-search input')) {
    event.preventDefault();
    showSearch(target.value);
  } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && target.id === 'agent-composer') {
    event.preventDefault();
    void send();
  } else if (target.getAttribute('role') === 'button' && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    target.click();
  } else if (event.key === 'Escape' && !dialog.open && document.querySelector('.sidebar.sidebar-open')) {
    closeMobile();
    document.querySelector('.mobile-menu-button').focus();
  }
});

window.addEventListener('popstate', () => { void followRoute(); });

render();
await refresh(false);
await followRoute();
