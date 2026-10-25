export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    if (response.status === 401) window.dispatchEvent(new Event('admin-session-expired'));
    throw new Error(data?.error || '无法连接图库服务，请使用 npm start 启动网站');
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
