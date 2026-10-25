import { api } from './api.js';
const form = document.querySelector('#adminLogin');
const message = document.querySelector('#adminMessage');
async function refresh() {
  try {
    const session = await api('/api/session');
    form.hidden = !session.configured || session.admin;
    document.querySelector('#adminSetup').hidden = session.configured;
    document.querySelector('#adminDashboard').hidden = !session.admin;
    message.textContent = '';
  } catch (error) { message.textContent = error.message; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true;
  message.textContent = '正在登录…';
  try {
    await api('/api/login', { method: 'POST', body: { password: form.elements.password.value } });
    form.reset(); await refresh();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#adminRefresh').addEventListener('click', refresh);
document.querySelector('#adminLogout').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); await refresh(); }
  catch (error) { message.textContent = error.message; }
});
refresh();
