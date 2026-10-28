import { api } from './api.js';
const form = document.querySelector('#adminLogin');
const message = document.querySelector('#adminMessage');
async function refresh() {
  try {
    const session = await api('/api/session');
    const otherUser = session.user && !session.admin;
    form.hidden = !session.configured || session.admin || !!otherUser;
    document.querySelector('#adminSetup').hidden = session.configured || !!otherUser;
    document.querySelector('#adminDashboard').hidden = !session.admin;
    document.querySelector('#adminOtherAccount').hidden = !otherUser;
    document.querySelector('#adminOtherIdentity').textContent = otherUser ? `当前已登录 @${session.user.username}。你可以管理自己的图库，但不能管理站点主人的作品。` : '';
    message.textContent = '';
  } catch (error) { message.textContent = error.message; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true;
  message.textContent = '正在登录…';
  try {
    await api('/api/login', { method: 'POST', body: { username: 'admin', password: form.elements.password.value } });
    form.reset(); await refresh();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#adminRefresh').addEventListener('click', refresh);
async function logout(event) {
  event.currentTarget.disabled = true;
  try { await api('/api/logout', { method:'POST' }); await refresh(); }
  catch (error) { message.textContent = error.message; }
  finally { document.querySelectorAll('#adminLogout, #adminSwitchAccount').forEach(button => { button.disabled = false; }); }
}
document.querySelector('#adminLogout').addEventListener('click', logout);
document.querySelector('#adminSwitchAccount').addEventListener('click', logout);
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
window.addEventListener('focus', refresh);
window.addEventListener('account-session-expired', refresh);
refresh();
