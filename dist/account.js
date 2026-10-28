import { api } from './api.js';

const auth = document.querySelector('#accountAuth');
const dashboard = document.querySelector('#accountDashboard');
const message = document.querySelector('#accountMessage');
const loginForm = document.querySelector('#accountLogin');
const registerForm = document.querySelector('#accountRegister');
const tabs = [...document.querySelectorAll('.account-tabs [role="tab"]')];
let currentUser = null;
let busy = false;
let mode = new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login';

function showMessage(text = '', error = false) {
  message.textContent = text;
  message.classList.toggle('is-error', error);
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('.account-form fieldset, .account-tabs button, #accountLogout').forEach(control => { control.disabled = value; });
  document.querySelector('.account-card').setAttribute('aria-busy', String(value));
}

function updateHeading() {
  document.querySelector('#accountTitle').textContent = currentUser ? `你好，${currentUser.name || currentUser.username}` : mode === 'register' ? '留下你的视角' : '欢迎回来';
  document.querySelector('#accountIntro').textContent = currentUser ? '你的作品、足迹与故事，都在这里。' : mode === 'register' ? '创建账号，拥有独立的图库与公开主页。' : '让每一次按下快门，都有自己的归处。';
}

function switchMode(nextMode, focusTab = false) {
  mode = nextMode;
  tabs.forEach(tab => {
    const selected = tab.id === `${mode}Tab`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focusTab) tab.focus();
  });
  showMessage();
  updateHeading();
}

function renderSession(session) {
  currentUser = session.user || null;
  auth.hidden = !!currentUser;
  dashboard.hidden = !currentUser;
  updateHeading();
  if (!currentUser) return;
  const isOwner = currentUser.role === 'admin';
  const query = isOwner ? '' : `user=${encodeURIComponent(currentUser.username)}&`;
  const publicPath = isOwner ? '/' : `/u/${encodeURIComponent(currentUser.username)}`;
  document.querySelector('#accountIdentity').textContent = isOwner ? '@admin · 站点管理员' : `@${currentUser.username} · 独立公开图库`;
  document.querySelector('#accountManage').href = `/portfolio.html?${query}manage=1`;
  document.querySelector('#accountProfile').href = `/index.html?${query}manage=profile`;
  document.querySelector('#accountPublic').href = publicPath;
  document.querySelector('#accountPublicLink').value = new URL(publicPath, location.origin).href;
}

async function refreshSession() {
  const session = await api('/api/session');
  renderSession(session);
  return session;
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => switchMode(index ? 'register' : 'login'));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
    switchMode(next ? 'register' : 'login', true);
  });
});

registerForm.elements.username.addEventListener('input', () => {
  const username = registerForm.elements.username.value.trim().toLowerCase();
  document.querySelector('#usernamePreview').textContent = `你的主页 /u/${username || 'username'}`;
});
for (const field of [registerForm.elements.password, registerForm.elements.confirmPassword]) {
  field.addEventListener('input', () => registerForm.elements.confirmPassword.setCustomValidity(''));
}

async function submitAccount(event, register) {
  event.preventDefault();
  if (busy) return;
  const form = register ? registerForm : loginForm;
  const username = form.elements.username.value.trim().toLowerCase();
  form.elements.username.value = username;
  if (register && form.elements.password.value !== form.elements.confirmPassword.value) {
    form.elements.confirmPassword.setCustomValidity('两次输入的密码不一致');
    form.elements.confirmPassword.reportValidity();
    return;
  }
  const body = { username, password: form.elements.password.value };
  if (register) {
    body.name = form.elements.name.value.trim();
    if (!body.name) { showMessage('请填写展示名称。', true); form.elements.name.focus(); return; }
  }
  setBusy(true);
  showMessage(register ? '正在创建你的图库…' : '正在登录…');
  try {
    await api(register ? '/api/register' : '/api/login', { method: 'POST', body });
    form.reset();
    await refreshSession();
    showMessage(register ? '账号已创建。现在可以上传第一张作品了。' : '登录成功。');
  } catch (error) { showMessage(error.message, true); }
  finally { setBusy(false); }
}

loginForm.addEventListener('submit', event => submitAccount(event, false));
registerForm.addEventListener('submit', event => submitAccount(event, true));
document.querySelector('#accountLogout').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await api('/api/logout', { method: 'POST' });
    loginForm.reset();
    registerForm.reset();
    renderSession({ user: null });
    switchMode('login');
    showMessage('已退出登录。你的公开作品仍可被浏览。');
  } catch (error) { showMessage(error.message, true); }
  finally { setBusy(false); }
});

document.querySelector('#accountCopy').addEventListener('click', async () => {
  const field = document.querySelector('#accountPublicLink');
  try {
    await navigator.clipboard.writeText(field.value);
    showMessage('主页链接已复制，可以分享给朋友。');
  } catch {
    field.focus();
    field.select();
    showMessage('已选中主页链接，请手动复制。');
  }
});

window.addEventListener('pageshow', event => {
  if (event.persisted && !busy) refreshSession().catch(error => showMessage(error.message, true));
});
window.addEventListener('account-session-expired', () => {
  loginForm.reset();
  registerForm.reset();
  renderSession({ user: null });
  switchMode('login');
  showMessage('登录已过期，请重新登录。', true);
});
window.addEventListener('focus', () => {
  if (!busy) refreshSession().catch(error => showMessage(error.message, true));
});

switchMode(mode);
showMessage('正在检查登录状态…');
refreshSession().then(() => showMessage()).catch(error => {
  renderSession({ user: null });
  showMessage(error.message, true);
});
