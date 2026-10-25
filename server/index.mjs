import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from './auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.geojson':'application/geo+json', '.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg', '.txt':'text/plain; charset=utf-8' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const numeric = (value, min, max) => Number.isFinite(value) && value >= min && value <= max ? value : null;
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
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, '请求格式无效'); }
}

export async function createPortfolioServer({ dataDir = resolve(root, '.data'), publicDir = resolve(root, 'dist'), origin = 'http://127.0.0.1:4173' } = {}) {
  dataDir = resolve(dataDir);
  publicDir = resolve(publicDir);
  origin = new URL(origin).origin;
  if (dataDir === publicDir || dataDir.startsWith(publicDir + sep)) throw new Error('数据目录必须放在公开文件目录之外');
  await mkdir(resolve(dataDir, 'media'), { recursive: true, mode: 0o700 });
  const libraryPath = resolve(dataDir, 'library.json');
  const credentialPath = resolve(dataDir, 'admin.json');
  const sessions = new Map();
  const attempts = new Map();
  let queue = Promise.resolve();
  let credentialVersion;
  const library = () => readJson(libraryPath, { photos: [], profile: {}, avatar: null });
  function mutate(callback) {
    const operation = queue.then(async () => { const data = await library(); const result = await callback(data); await atomicJson(libraryPath, data); return result; });
    queue = operation.catch(() => {}); return operation;
  }
  function send(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(data)); }
  const cookie = (value, age) => `portfolio_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.headers.host !== new URL(origin).host) throw fail(403, '站点地址不匹配');
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const credentials = await readJson(credentialPath, null);
        if (credentialVersion !== credentials?.hash) { sessions.clear(); credentialVersion = credentials?.hash; }
        const now = Date.now();
        for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
        for (const [key, attempt] of attempts) if (attempt.until < now) attempts.delete(key);
        const token = /(?:^|;\s*)portfolio_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        const authenticated = !!token && sessions.has(token);
        if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { admin: authenticated, configured: !!credentials });
        if (req.method === 'GET' && url.pathname === '/api/library') return send(res, 200, await library());
        if (req.headers.origin !== origin) throw fail(403, '请求来源无效');
        if (req.method === 'POST' && url.pathname === '/api/login') {
          if (!credentials) throw fail(503, '请先在服务器终端运行 npm run admin:password 设置管理员密码');
          const ip = req.socket.remoteAddress;
          const attempt = attempts.get(ip) || { count: 0, until: now + 15 * 60_000 };
          if (attempt.count >= 5 || attempts.size > 10000) throw fail(429, '尝试次数过多，请 15 分钟后重试');
          attempt.count++; attempts.set(ip, attempt);
          const input = await bodyJson(req, 2048) || {};
          if (!await verifyPassword(input.password, credentials)) throw fail(401, '密码不正确');
          attempts.delete(ip);
          const sessionToken = randomBytes(32).toString('hex');
          if (token) sessions.delete(token);
          sessions.set(sessionToken, { expires: now + 12 * 60 * 60_000 });
          res.setHeader('Set-Cookie', cookie(sessionToken, 12 * 60 * 60));
          return send(res, 200, { admin: true });
        }
        if (!authenticated) throw fail(401, '请先以管理员身份登录');
        if (req.method === 'POST' && url.pathname === '/api/logout') {
          sessions.delete(token); res.setHeader('Set-Cookie', cookie('', 0)); return send(res, 200, { ok: true });
        }
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
          await mutate(async data => {
            if (data.photos.length >= 500) throw fail(400, '图库已达到 500 张上限');
            await writeFile(resolve(dataDir, `media/${photo.id}.webp`), bytes, { mode: 0o600 });
            await writeFile(resolve(dataDir, `media/${photo.id}-thumb.webp`), thumbnail, { mode: 0o600 });
            data.photos.unshift(photo);
          });
          return send(res, 201, photo);
        }
        if (req.method === 'DELETE' && /^\/api\/photos\/[a-f0-9-]{36}$/.test(url.pathname)) {
          const id = url.pathname.split('/').pop();
          await mutate(data => { if (!data.photos.some(p => p.id === id)) throw fail(404, '照片不存在'); data.photos = data.photos.filter(p => p.id !== id); });
          // Original files stay on disk for recovery; unlisted media is no longer publicly served.
          return send(res, 200, { ok: true });
        }
        if (req.method === 'PUT' && url.pathname === '/api/profile') {
          const input = await bodyJson(req, 8192); const profile = {};
          for (const [key, max] of Object.entries({name:30,role:50,bio:140,location:60,email:80})) profile[key] = clean(input[key], max);
          await mutate(data => { data.profile = profile; }); return send(res, 200, profile);
        }
        if (req.method === 'PUT' && url.pathname === '/api/avatar') {
          const bytes = imageBytes((await bodyJson(req)).image); const name = `${randomUUID()}.webp`;
          await mutate(async data => { await writeFile(resolve(dataDir, 'media', name), bytes, { mode: 0o600 }); data.avatar = `/media/${name}`; });
          return send(res, 200, { avatar: `/media/${name}` });
        }
        throw fail(404, '接口不存在');
      }
      if (!['GET','HEAD'].includes(req.method)) throw fail(405, '不支持此方法');
      let file;
      if (url.pathname.startsWith('/media/')) {
        const data = await library();
        if (!(data.avatar === url.pathname || data.photos.some(p => p.src === url.pathname || p.thumbnailSrc === url.pathname))) throw fail(404, '图片不存在');
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
