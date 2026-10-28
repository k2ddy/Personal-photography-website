export async function api(path, { method = 'GET', body, owner } = {}) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (owner) headers['X-Portfolio-Owner'] = owner;
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    if (response.status === 401 || response.status === 409 && owner) window.dispatchEvent(new Event('account-session-expired'));
    const error = new Error(data?.error || '无法连接图库服务，请使用 npm start 启动网站');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
