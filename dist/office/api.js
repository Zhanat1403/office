export class OfficeApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function open(path, { method = 'GET', data } = {}) {
  const form = data instanceof FormData;
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: data !== undefined && !form ? { 'Content-Type': 'application/json' } : undefined,
      body: data === undefined || form ? data : JSON.stringify(data),
      cache: 'no-store',
    });
  } catch {
    throw new OfficeApiError('Сервер недоступен. Проверьте подключение и попробуйте снова.', 0);
  }

  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new OfficeApiError(details.error || 'Не удалось выполнить действие. Попробуйте снова.', response.status);
  }
  return response;
}

export async function request(path, config) {
  const response = await open(path, config);
  return response.status === 204 ? null : response.json();
}

export function uploadFile(file) {
  const form = new FormData();
  form.set('file', file);
  return request('/documents', { method: 'POST', data: form });
}

export async function streamChat(data, receive) {
  const response = await open('/chat', { method: 'POST', data });
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new OfficeApiError('Сервер вернул ответ в неизвестном формате.', response.status);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let completed = false;

  function dispatch(block) {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    receive(event);
    if (event.type === 'done') completed = true;
    if (event.type === 'error') throw new OfficeApiError(event.error || 'Не удалось завершить анализ.', 500);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        dispatch(pending.slice(0, separator.index));
        pending = pending.slice(separator.index + separator[0].length);
      }
    }
    if (pending.trim()) dispatch(pending);
    if (!completed) throw new OfficeApiError('Поток ответа прервался. Проверьте историю перед повтором.', 0);
  } catch (error) {
    if (error instanceof OfficeApiError) throw error;
    throw new OfficeApiError('Поток ответа прервался. Проверьте историю перед повтором.', 0);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
