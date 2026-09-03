(() => {
  'use strict';
  const root = document.querySelector('[data-task-console]'); if (!root) return;
  const api = '/tech-persistence/api/v1'; let session = null;
  const loginPanel = root.querySelector('[data-login-panel]'); const appPanel = root.querySelector('[data-app-panel]');
  const taskList = root.querySelector('[data-task-list]'); const taskError = root.querySelector('[data-task-error]');
  async function request(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json', 'X-TP-Client': '1' } : {}),
      ...(options.mutate && session ? { 'X-TP-CSRF': session.csrfToken } : {}) };
    const response = await fetch(`${api}${path}`, { credentials: 'same-origin', method: options.method || 'GET', headers,
      body: options.body ? JSON.stringify(options.body) : undefined, cache: 'no-store' });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `http_${response.status}`); return data;
  }
  function button(label, action) { const value = document.createElement('button'); value.type = 'button'; value.className = 'button button--secondary'; value.textContent = label; value.addEventListener('click', action); return value; }
  async function mutateTask(task, action, body = {}) { taskError.textContent = ''; try { await request(`/tasks/${task.id}/${action}`, { method: 'POST', mutate: true, body }); await loadTasks(); } catch (error) { taskError.textContent = `操作失败：${error.message}`; } }
  function renderTask(task) {
    const card = document.createElement('article'); card.className = 'task-card';
    const title = document.createElement('h4'); title.textContent = task.projectId; const state = document.createElement('span'); state.className = 'task-state'; state.textContent = task.terminalCode ? `${task.state} · ${task.terminalCode}` : task.state;
    const text = document.createElement('p'); text.textContent = task.requirement || '';
    const transcript = document.createElement('p'); transcript.textContent = `Transcript：${task.transcript?.status || 'pending'} · ${task.transcript?.eventCount || 0} events`;
    const actions = document.createElement('div'); actions.className = 'task-actions';
    if (task.state === 'draft') actions.append(button('执行', () => mutateTask(task, 'execute', { idempotencyKey: crypto.randomUUID() })));
    if (task.confirmationRequired) actions.append(button('确认规格并继续', () => mutateTask(task, 'confirm')));
    if (['queued', 'claimed', 'running'].includes(task.state)) actions.append(button('取消', () => mutateTask(task, 'cancel')));
    card.append(title, state, text, transcript, actions); return card;
  }
  async function loadTasks() {
    const page = await request('/tasks'); const details = await Promise.all(page.items.map(async item => {
      const [detail, transcript] = await Promise.all([request(`/tasks/${item.id}`), request(`/tasks/${item.id}/transcript`)]);
      return { ...detail.task, transcript: transcript.transcript };
    }));
    taskList.replaceChildren(...details.map(renderTask)); if (!details.length) taskList.textContent = '暂无任务。';
  }
  async function enterApp(value) {
    session = value; loginPanel.hidden = true; appPanel.hidden = false; root.querySelector('[data-user-label]').textContent = value.user.username;
    const projects = (await request('/projects')).projects; const select = root.querySelector('[data-projects]'); select.replaceChildren(...projects.filter(item => item.canCreate).map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option; }));
    await loadTasks();
  }
  root.querySelector('[data-login-form]').addEventListener('submit', async event => { event.preventDefault(); const error = root.querySelector('[data-login-error]'); error.textContent = ''; const input = new FormData(event.currentTarget); try { await enterApp(await request('/auth/login', { method: 'POST', body: { username: input.get('username'), password: input.get('password') } })); event.currentTarget.reset(); } catch (reason) { error.textContent = `登录失败：${reason.message}`; } });
  root.querySelector('[data-task-form]').addEventListener('submit', async event => { event.preventDefault(); taskError.textContent = ''; const input = new FormData(event.currentTarget); try { const created = await request('/tasks', { method: 'POST', mutate: true, body: { projectId: input.get('projectId'), requirement: input.get('requirement'), idempotencyKey: crypto.randomUUID() } }); await mutateTask(created.task, 'execute', { idempotencyKey: crypto.randomUUID() }); event.currentTarget.reset(); } catch (reason) { taskError.textContent = `创建失败：${reason.message}`; } });
  root.querySelector('[data-refresh]').addEventListener('click', () => loadTasks().catch(error => { taskError.textContent = error.message; }));
  root.querySelector('[data-logout]').addEventListener('click', async () => { try { await request('/auth/logout', { method: 'POST', mutate: true, body: {} }); } finally { session = null; appPanel.hidden = true; loginPanel.hidden = false; taskList.replaceChildren(); } });
  request('/auth/session').then(enterApp).catch(() => {});
})();
