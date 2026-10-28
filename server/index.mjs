import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword } from './auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.geojson':'application/geo+json', '.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg', '.txt':'text/plain; charset=utf-8' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const numeric = (value, min, max) => Number.isFinite(value) && value >= min && value <= max ? value : null;
const normalizeUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validUsername = value => /^[a-z][a-z0-9_]{2,23}$/.test(value);
const reservedUsernames = new Set(['admin', 'administrator', 'root', 'system', 'api', 'media', 'assets', 'account', 'accounts', 'login', 'logout', 'register', 'signup', 'signin', 'index', 'home', 'portfolio', 'about', 'map', 'users', 'user', 'support', 'settings']);
const emptyLibrary = () => ({ photos: [], profile: {}, avatar: null });
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
function imageBytes(value) {
  if (typeof value !== 'string' || value.length > 17_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail(400, '图片数据无效');
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw fail(400, '图片超过 12 MB');
  // The browser normalizes display images to WebP; disallow active image formats such as SVG.
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw fail(400, '请上传经过处理的 WebP 展示图');
  return buffer;
}
async function bodyJson(req, limit = 20 * 1024 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, '需要 JSON 请求');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, '请求过大'); chunks.push(chunk); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, '请求格式无效'); }
}

export async function createPortfolioServer({ dataDir = resolve(root, '.data'), publicDir = resolve(root, 'dist'), origin = 'http://127.0.0.1:4173' } = {}) {
  dataDir = resolve(dataDir);
  publicDir = resolve(publicDir);
  origin = new URL(origin).origin;
  if (dataDir === publicDir || dataDir.startsWith(publicDir + sep)) throw new Error('数据目录必须放在公开文件目录之外');
  await mkdir(resolve(dataDir, 'media'), { recursive: true, mode: 0o700 });
  await mkdir(resolve(dataDir, 'users'), { recursive: true, mode: 0o700 });
  const libraryPath = resolve(dataDir, 'library.json');
  const credentialPath = resolve(dataDir, 'admin.json');
  const accountsPath = resolve(dataDir, 'accounts.json');
  const sessions = new Map();
  const attempts = new Map();
  const registrations = new Map();
  let queue = Promise.resolve();
  let credentialVersion;
  const siteOwner = { id: 'admin', username: 'admin', role: 'admin' };
  const accounts = () => readJson(accountsPath, []);
  const ownerLibraryPath = owner => owner.id === 'admin' ? libraryPath : resolve(dataDir, 'users', `${owner.id}.json`);
  const library = (owner = siteOwner) => readJson(ownerLibraryPath(owner), emptyLibrary());
  function serialize(callback) {
    const operation = queue.then(callback);
    queue = operation.catch(() => {}); return operation;
  }
  function mutate(owner, callback) {
    return serialize(async () => { const data = await library(owner); const result = await callback(data); await atomicJson(ownerLibraryPath(owner), data); return result; });
  }
  async function publicOwner(username) {
    if (!username || username === 'admin') return siteOwner;
    if (!validUsername(username)) throw fail(404, '摄影师主页不存在');
    const account = (await accounts()).find(item => item.username === username);
    if (!account) throw fail(404, '摄影师主页不存在');
    return { id: account.id, username: account.username, role: 'user' };
  }
  function describeOwner(owner, data) {
    return { id: owner.id, username: owner.username, name: data.profile?.name || (owner.id === 'admin' ? '我的摄影主页' : owner.username), publicUrl: owner.id === 'admin' ? '/' : `/u/${owner.username}` };
  }
  async function sessionUser(session) {
    if (!session) return null;
    return { ...describeOwner(session.owner, await library(session.owner)), role: session.owner.role };
  }
  function rateLimit(store, ip, now, max, message) {
    const attempt = store.get(ip) || { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= max || store.size >= 10000) throw fail(429, message);
    attempt.count++; store.set(ip, attempt);
  }
  function send(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(data)); }
  const cookie = (value, age) => `portfolio_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
  function signIn(res, owner, previousToken, now) {
    if (sessions.size >= 10000) throw fail(503, '当前登录人数过多，请稍后重试');
    const sessionToken = randomBytes(32).toString('hex');
    if (previousToken) sessions.delete(previousToken);
    sessions.set(sessionToken, { owner, expires: now + 12 * 60 * 60_000 });
    res.setHeader('Set-Cookie', cookie(sessionToken, 12 * 60 * 60));
    return sessions.get(sessionToken);
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.headers.host !== new URL(origin).host) throw fail(403, '站点地址不匹配');
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const credentials = await readJson(credentialPath, null);
        if (credentialVersion !== credentials?.hash) {
          for (const [key, session] of sessions) if (session.owner.id === 'admin') sessions.delete(key);
          credentialVersion = credentials?.hash;
        }
        const now = Date.now();
        for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
        for (const [key, attempt] of attempts) if (attempt.until < now) attempts.delete(key);
        for (const [key, attempt] of registrations) if (attempt.until < now) registrations.delete(key);
        const token = /(?:^|;\s*)portfolio_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        const session = token ? sessions.get(token) : null;
        if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { admin: session?.owner.id === 'admin', configured: !!credentials, user: await sessionUser(session) });
        if (req.method === 'GET' && url.pathname === '/api/library') {
          const owner = await publicOwner(normalizeUsername(url.searchParams.get('user')));
          const data = await library(owner);
          return send(res, 200, { ...data, owner: describeOwner(owner, data) });
        }
        if (req.headers.origin !== origin) throw fail(403, '请求来源无效');
        if (req.method === 'POST' && url.pathname === '/api/register') {
          rateLimit(registrations, req.socket.remoteAddress, now, 5, '注册尝试过多，请 15 分钟后重试');
          const input = await bodyJson(req, 4096);
          const username = normalizeUsername(input.username);
          if (!validUsername(username) || reservedUsernames.has(username)) throw fail(400, '用户名需以字母开头，包含 3–24 位字母、数字或下划线，且不能使用保留名称');
          if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) throw fail(400, '密码需要 12–256 个字符');
          if (input.name !== undefined && (typeof input.name !== 'string' || input.name.trim().length > 30)) throw fail(400, '显示名称不能超过 30 个字符');
          const password = await hashPassword(input.password);
          const owner = { id: randomUUID(), username, role: 'user' };
          await serialize(async () => {
            const existing = await accounts();
            if (existing.some(item => item.username === username)) throw fail(409, '这个用户名已被使用');
            const data = emptyLibrary();
            data.profile.name = clean(input.name, 30) || username;
            // Write the library first: an interrupted registration can never expose another user's data.
            await atomicJson(ownerLibraryPath(owner), data);
            existing.push({ id: owner.id, username, credentials: password, createdAt: now });
            await atomicJson(accountsPath, existing);
          });
          return send(res, 201, { user: await sessionUser(signIn(res, owner, token, now)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/login') {
          const ip = req.socket.remoteAddress;
          rateLimit(attempts, ip, now, 5, '尝试次数过多，请 15 分钟后重试');
          const input = await bodyJson(req, 4096);
          const username = normalizeUsername(input.username) || 'admin';
          let owner = siteOwner; let password = credentials;
          if (username !== 'admin') {
            const account = validUsername(username) ? (await accounts()).find(item => item.username === username) : null;
            owner = account ? { id: account.id, username: account.username, role: 'user' } : null;
            password = account?.credentials;
          } else if (!credentials) throw fail(503, '请先在服务器终端运行 npm run admin:password 设置管理员密码');
          if (!owner || !await verifyPassword(input.password, password)) throw fail(401, '用户名或密码不正确');
          attempts.delete(ip);
          const signedIn = signIn(res, owner, token, now);
          return send(res, 200, { admin: owner.id === 'admin', user: await sessionUser(signedIn) });
        }
        if (!session) throw fail(401, '请先登录账号');
        if (req.method === 'POST' && url.pathname === '/api/logout') {
          sessions.delete(token); res.setHeader('Set-Cookie', cookie('', 0)); return send(res, 200, { ok: true });
        }
        const owner = session.owner;
        if (req.headers['x-portfolio-owner'] !== undefined && req.headers['x-portfolio-owner'] !== owner.id) throw fail(409, '账号已切换，请刷新页面后重试');
        if (req.method === 'POST' && url.pathname === '/api/photos') {
          const input = await bodyJson(req);
          const bytes = imageBytes(input.image); const thumbnail = imageBytes(input.thumbnail);
          const info = input.metadata || {};
          const photo = { id: randomUUID(), createdAt: Date.now(), size: bytes.length };
          for (const key of ['title','category','year','alt','location','device','lens','focalLength','aperture','shutter','iso','capturedAt','fileName']) photo[key] = clean(info[key]);
          photo.title ||= '未命名作品'; photo.category ||= '未分类';
          photo.year ||= String(new Date().getFullYear());
          photo.shape = ['wide','tall','square'].includes(info.shape) ? info.shape : 'square';
          photo.latitude = numeric(info.latitude, -90, 90); photo.longitude = numeric(info.longitude, -180, 180);
          photo.width = numeric(info.width, 1, 16000); photo.height = numeric(info.height, 1, 16000);
          photo.src = `/media/${photo.id}.webp`; photo.thumbnailSrc = `/media/${photo.id}-thumb.webp`;
          await mutate(owner, async data => {
            if (data.photos.length >= 500) throw fail(400, '图库已达到 500 张上限');
            await writeFile(resolve(dataDir, `media/${photo.id}.webp`), bytes, { mode: 0o600 });
            await writeFile(resolve(dataDir, `media/${photo.id}-thumb.webp`), thumbnail, { mode: 0o600 });
            data.photos.unshift(photo);
          });
          return send(res, 201, photo);
        }
        if (req.method === 'DELETE' && /^\/api\/photos\/[a-f0-9-]{36}$/.test(url.pathname)) {
          const id = url.pathname.split('/').pop();
          await mutate(owner, data => { if (!data.photos.some(p => p.id === id)) throw fail(404, '照片不存在'); data.photos = data.photos.filter(p => p.id !== id); });
          // Original files stay on disk for recovery; unlisted media is no longer publicly served.
          return send(res, 200, { ok: true });
        }
        if (req.method === 'PUT' && url.pathname === '/api/profile') {
          const input = await bodyJson(req, 8192); const profile = {};
          for (const [key, max] of Object.entries({name:30,role:50,bio:140,location:60,email:80})) profile[key] = clean(input[key], max);
          await mutate(owner, data => { data.profile = profile; }); return send(res, 200, profile);
        }
        if (req.method === 'PUT' && url.pathname === '/api/avatar') {
          const bytes = imageBytes((await bodyJson(req)).image); const name = `${randomUUID()}.webp`;
          await mutate(owner, async data => { await writeFile(resolve(dataDir, 'media', name), bytes, { mode: 0o600 }); data.avatar = `/media/${name}`; });
          return send(res, 200, { avatar: `/media/${name}` });
        }
        throw fail(404, '接口不存在');
      }
      if (!['GET','HEAD'].includes(req.method)) throw fail(405, '不支持此方法');
      if (url.pathname.startsWith('/u/')) {
        const username = normalizeUsername(url.pathname.slice(3));
        if (!username || url.pathname.endsWith('/')) throw fail(404, '摄影师主页不存在');
        const owner = await publicOwner(username);
        res.writeHead(302, { Location: owner.id === 'admin' ? '/' : `/index.html?user=${owner.username}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      let file;
      if (url.pathname.startsWith('/media/')) {
        if (!/^\/media\/[a-f0-9-]{36}(?:-thumb)?\.webp$/.test(url.pathname)) throw fail(404, '图片不存在');
        const owners = [siteOwner, ...await accounts()];
        let referenced = false;
        for (const owner of owners) {
          const data = await library(owner);
          if (data.avatar === url.pathname || data.photos.some(p => p.src === url.pathname || p.thumbnailSrc === url.pathname)) { referenced = true; break; }
        }
        if (!referenced) throw fail(404, '图片不存在');
        file = resolve(dataDir, `.${url.pathname}`);
      } else {
        const path = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : decodeURIComponent(url.pathname);
        file = resolve(publicDir, `.${path}`);
        if (!file.startsWith(publicDir + sep) || path.split('/').some(part => part.startsWith('.'))) throw fail(404, '页面不存在');
      }
      if (!(await stat(file)).isFile()) throw fail(404, '页面不存在');
      res.writeHead(200, { 'Content-Type':types[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (!res.headersSent) send(res, status, { error: status === 500 ? '服务暂时不可用，请稍后重试' : error.message });
      else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const origin = process.env.SITE_ORIGIN || `http://127.0.0.1:${port}`;
  const server = await createPortfolioServer({ dataDir: resolve(process.env.PORTFOLIO_DATA_DIR || resolve(root, '.data')), origin });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`摄影站点：${origin}\n管理员入口：${origin}/admin.html`));
}
