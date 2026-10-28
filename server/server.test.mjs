import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createServer as createPortProbe } from 'node:net';
import { createPortfolioServer } from './index.mjs';
import { hashPassword } from './auth.mjs';

async function availablePort() {
  const probe = createPortProbe();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolveClose => probe.close(resolveClose));
  return port;
}

async function fixture({ adminPassword } = {}) {
  const port = await availablePort();
  const directory = await mkdtemp(resolve(tmpdir(), 'portfolio-users-test-'));
  const origin = `http://127.0.0.1:${port}`;
  let server;
  async function start() {
    server = await createPortfolioServer({ dataDir: directory, origin });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
  }
  async function stop() {
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  }
  try {
    if (adminPassword) await writeFile(resolve(directory, 'admin.json'), JSON.stringify(await hashPassword(adminPassword)));
    await start();
  } catch (error) {
    await stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    async request(path, { method = 'GET', body, cookie, headers = {}, redirect = 'follow' } = {}) {
      return fetch(origin + path, {
        method,
        redirect,
        headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async restart() { await stop(); await start(); },
    async dispose() { await stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

const sessionCookie = response => {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'Successful authentication must issue a session cookie');
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Strict/);
  return value.split(';')[0];
};

const testImage = async () => (await readFile(new URL('../dist/assets/demo/coast-hero.webp', import.meta.url))).toString('base64');

test('visitor isolation, admin writes, shared data, persistence and revocation', async () => {
  const port = await availablePort();
  const directory = await mkdtemp(resolve(tmpdir(), 'portfolio-auth-test-'));
  let server;
  const siteOrigin = `http://127.0.0.1:${port}`;
  try {
    const password = 'test-only-password-2026';
    await writeFile(resolve(directory, 'admin.json'), JSON.stringify(await hashPassword(password)));
    server = await createPortfolioServer({ dataDir: directory, origin:siteOrigin });
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
    let base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    const request = (path, method = 'GET', body, admin = false, origin = siteOrigin) => fetch(base + path, {
      method, headers: { Origin:origin, ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(admin ? {Cookie:cookie} : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal((await (await request('/api/session')).json()).admin, false);
    assert.equal((await request('/api/photos','POST',{})).status,401);
    assert.equal((await request('/api/profile','PUT',{})).status,401);
    assert.equal((await request('/api/avatar','PUT',{})).status,401);
    assert.equal((await request('/api/login','POST',{password:'wrong'})).status,401);
    assert.equal((await request('/api/login','POST',{password},false,'https://other.invalid')).status,403);
    const login = await request('/api/login','POST',{password});
    assert.equal(login.status,200);
    assert.match(login.headers.get('set-cookie'),/HttpOnly/);
    assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
    cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await request('/api/session','GET',undefined,true)).json()).admin,true);
    const image=(await readFile(new URL('../dist/assets/demo/coast-hero.webp',import.meta.url))).toString('base64');
    const added=await request('/api/photos','POST',{image,thumbnail:image,metadata:{title:'Shared photo',latitude:31.2304,longitude:121.4737,shape:'wide'}},true);
    assert.equal(added.status,201); const photo=await added.json();
    assert.equal((await (await request('/api/library')).json()).photos[0].title,'Shared photo');
    assert.equal((await request(photo.src)).status,200);
    assert.equal((await request('/api/photos','POST',{image:'bad',thumbnail:'bad'},true)).status,400);
    assert.equal((await request('/api/profile','PUT',{name:'Owner'},true)).status,200);
    assert.equal((await (await request('/api/library')).json()).profile.name,'Owner');
    assert.equal((await request('/api/profile','PUT',{name:'Intruder'},true,'https://other.invalid')).status,403);
    assert.equal((await request(`/api/photos/${photo.id}`,'DELETE')).status,401);
    assert.equal((await request('/.data/admin.json')).status,404);
    assert.equal((await request('/server/auth.mjs')).status,404);
    assert.equal((await request('/api/logout','POST',undefined,true)).status,200);
    assert.equal((await request('/api/photos','POST',{},true)).status,401);
    await new Promise(resolveClose=>server.close(resolveClose));
    server=await createPortfolioServer({ dataDir:directory,origin:siteOrigin });
    server.listen(port,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await request('/api/library')).json()).photos.length,1);
    const second=await request('/api/login','POST',{password});cookie=second.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(`/api/photos/${photo.id}`,'DELETE',undefined,true)).status,200);
    assert.equal((await request(photo.src)).status,404);
    assert.equal((await (await request('/api/library')).json()).photos.length,0);
    await writeFile(resolve(directory,'admin.json'),JSON.stringify(await hashPassword('replacement-password-2026')));
    assert.equal((await request('/api/profile','PUT',{name:'Old session'},true)).status,401);
    for(let i=0;i<5;i++) await request('/api/login','POST',{password:'wrong'});
    assert.equal((await request('/api/login','POST',{password:'wrong'})).status,429);
  } finally {
    if(server?.listening) await new Promise(resolveClose=>server.close(resolveClose));
    await rm(directory,{recursive:true,force:true});
  }
});

test('registered users have separate public libraries, private credentials and owner-scoped writes', async () => {
  const adminPassword = 'owner-test-password-2026';
  const alicePassword = 'alice-test-password-2026';
  const bobPassword = 'bob-test-password-2026';
  const site = await fixture({ adminPassword });
  try {
    const image = await testImage();
    const adminLogin = await site.request('/api/login', { method: 'POST', body: { password: adminPassword } });
    assert.equal(adminLogin.status, 200);
    let adminCookie = sessionCookie(adminLogin);
    const adminSession = await (await site.request('/api/session', { cookie: adminCookie })).json();
    assert.equal(adminSession.admin, true);
    assert.equal(adminSession.user.username, 'admin');
    assert.equal(adminSession.user.publicUrl, '/');
    const ownerUpload = await site.request('/api/photos', { method: 'POST', cookie: adminCookie, body: { image, thumbnail: image, metadata: { title: 'Original owner photo' } } });
    assert.equal(ownerUpload.status, 201);
    const ownerPhoto = await ownerUpload.json();
    assert.equal((await site.request('/api/profile', { method: 'PUT', cookie: adminCookie, body: { name: 'Original owner' } })).status, 200);

    async function register(username, name, password) {
      const response = await site.request('/api/register', { method: 'POST', body: { username, name, password } });
      assert.equal(response.status, 201);
      const cookie = sessionCookie(response);
      const session = await (await site.request('/api/session', { cookie })).json();
      assert.equal(session.admin, false);
      assert.ok(session.user.id);
      assert.notEqual(session.user.role, 'admin');
      assert.equal(session.user.username, username.toLowerCase());
      assert.equal(session.user.name, name);
      assert.equal(session.user.publicUrl, `/u/${username.toLowerCase()}`);
      assert.equal(session.user.password, undefined);
      assert.equal(session.user.hash, undefined);
      assert.equal(session.user.salt, undefined);
      return { cookie, user: session.user };
    }
    const alice = await register('Alice_Lens', 'Alice', alicePassword);
    const bob = await register('bob_lens', 'Bob', bobPassword);
    assert.notEqual(alice.user.id, bob.user.id);
    assert.notEqual(alice.user.id, adminSession.user.id);
    const publicLibrary = async username => (await site.request(`/api/library${username ? `?user=${username}` : ''}`)).json();
    assert.equal((await publicLibrary('alice_lens')).photos.length, 0);
    assert.equal((await publicLibrary('bob_lens')).photos.length, 0);

    const aliceUpload = await site.request('/api/photos?user=bob_lens', {
      method: 'POST', cookie: alice.cookie, headers: { 'X-Portfolio-Owner': alice.user.id },
      body: { image, thumbnail: image, userId: bob.user.id, metadata: { title: 'Alice public photo', ownerId: bob.user.id, userId: 'admin', latitude: 31.2304, longitude: 121.4737 } },
    });
    assert.equal(aliceUpload.status, 201);
    const alicePhoto = await aliceUpload.json();
    const bobUpload = await site.request('/api/photos', { method: 'POST', cookie: bob.cookie, body: { image, thumbnail: image, metadata: { title: 'Bob public photo' } } });
    assert.equal(bobUpload.status, 201);
    const bobPhoto = await bobUpload.json();

    assert.deepEqual((await publicLibrary()).photos.map(photo => photo.id), [ownerPhoto.id]);
    assert.equal((await publicLibrary()).profile.name, 'Original owner');
    const aliceLibrary = await publicLibrary('alice_lens');
    assert.equal(aliceLibrary.owner.id, alice.user.id);
    assert.deepEqual(aliceLibrary.photos.map(photo => photo.id), [alicePhoto.id]);
    assert.equal(aliceLibrary.photos[0].title, 'Alice public photo');
    assert.equal(aliceLibrary.photos[0].latitude, 31.2304);
    assert.deepEqual((await publicLibrary('bob_lens')).photos.map(photo => photo.id), [bobPhoto.id]);
    for (const path of [alicePhoto.src, alicePhoto.thumbnailSrc, bobPhoto.src, ownerPhoto.src]) assert.equal((await site.request(path)).status, 200);
    assert.equal((await site.request(`/api/photos/${bobPhoto.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 404);
    assert.equal((await site.request(`/api/photos/${alicePhoto.id}`, { method: 'DELETE', cookie: adminCookie })).status, 404);
    assert.equal((await site.request(`/api/photos/${ownerPhoto.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);

    const staleHeaders = { 'X-Portfolio-Owner': alice.user.id };
    assert.equal((await site.request('/api/profile', { method: 'PUT', cookie: bob.cookie, headers: staleHeaders, body: { name: 'Wrong account' } })).status, 409);
    assert.equal((await site.request('/api/photos', { method: 'POST', cookie: bob.cookie, headers: staleHeaders, body: { image, thumbnail: image, metadata: { title: 'Wrong account' } } })).status, 409);
    assert.equal((await site.request(`/api/photos/${bobPhoto.id}`, { method: 'DELETE', cookie: bob.cookie, headers: staleHeaders })).status, 409);
    assert.equal((await publicLibrary('bob_lens')).profile.name, 'Bob');
    assert.equal((await publicLibrary('bob_lens')).photos.length, 1);

    assert.equal((await site.request('/api/profile?user=bob_lens', { method: 'PUT', cookie: alice.cookie, body: { name: 'Alice Updated', bio: 'A public photography page', role: 'Photographer', username: 'bob_lens', userId: bob.user.id, admin: true } })).status, 200);
    assert.equal((await publicLibrary('alice_lens')).profile.name, 'Alice Updated');
    assert.equal((await publicLibrary('bob_lens')).profile.name, 'Bob');
    const aliceUpdatedSession = await (await site.request('/api/session', { cookie: alice.cookie })).json();
    assert.equal(aliceUpdatedSession.admin, false);
    assert.equal(aliceUpdatedSession.user.username, 'alice_lens');
    assert.notEqual(aliceUpdatedSession.user.role, 'admin');
    const avatarResponse = await site.request('/api/avatar', { method: 'PUT', cookie: alice.cookie, body: { image } });
    assert.equal(avatarResponse.status, 200);
    const { avatar } = await avatarResponse.json();
    assert.equal((await publicLibrary('alice_lens')).avatar, avatar);
    assert.equal((await publicLibrary('bob_lens')).avatar, null);
    assert.equal((await publicLibrary()).avatar, null);
    assert.equal((await site.request(avatar)).status, 200);

    const redirect = await site.request('/u/alice_lens', { redirect: 'manual' });
    assert.ok([301, 302, 303, 307, 308].includes(redirect.status));
    assert.equal(redirect.headers.get('location'), '/index.html?user=alice_lens');
    assert.equal((await site.request('/api/library?user=nobody_here')).status, 404);
    assert.equal((await site.request('/u/nobody_here', { redirect: 'manual' })).status, 404);
    assert.equal((await site.request('/api/library?user=..%2Fadmin')).status, 404);
    for (const path of ['/.data/users.json', '/.data/accounts.json', '/.data/admin.json', '/users.json', '/accounts.json', '/server/index.mjs']) assert.equal((await site.request(path)).status, 404);
    for (const value of [await publicLibrary(), await publicLibrary('alice_lens'), await publicLibrary('bob_lens')]) {
      const json = JSON.stringify(value);
      assert.ok(!json.includes(alicePassword) && !json.includes(bobPassword) && !json.includes(adminPassword));
      assert.ok(!json.includes('"hash":') && !json.includes('"salt":') && !json.includes('"password":'));
    }

    assert.equal((await site.request('/api/logout', { method: 'POST', cookie: alice.cookie, headers: { 'X-Portfolio-Owner': bob.user.id } })).status, 200);
    assert.equal((await site.request('/api/profile', { method: 'PUT', cookie: alice.cookie, body: { name: 'Expired' } })).status, 401);
    assert.equal((await (await site.request('/api/session', { cookie: bob.cookie })).json()).user.id, bob.user.id);
    assert.equal((await publicLibrary('alice_lens')).photos.length, 1);
    assert.equal((await site.request('/api/login', { method: 'POST', body: { username: 'alice_lens', password: bobPassword } })).status, 401);

    await site.restart();
    assert.equal((await (await site.request('/api/session', { cookie: bob.cookie })).json()).user, null);
    assert.equal((await publicLibrary('alice_lens')).avatar, avatar);
    assert.equal((await publicLibrary('alice_lens')).profile.name, 'Alice Updated');
    assert.deepEqual((await publicLibrary('alice_lens')).photos.map(photo => photo.id), [alicePhoto.id]);
    assert.deepEqual((await publicLibrary('bob_lens')).photos.map(photo => photo.id), [bobPhoto.id]);
    assert.deepEqual((await publicLibrary()).photos.map(photo => photo.id), [ownerPhoto.id]);
    for (const [username, password, expectedId] of [['ALICE_LENS', alicePassword, alice.user.id], ['bob_lens', bobPassword, bob.user.id], ['admin', adminPassword, adminSession.user.id]]) {
      const login = await site.request('/api/login', { method: 'POST', body: { username, password } });
      assert.equal(login.status, 200);
      const cookie = sessionCookie(login);
      assert.equal((await (await site.request('/api/session', { cookie })).json()).user.id, expectedId);
      if (username === 'admin') adminCookie = cookie;
      if (username === 'bob_lens') bob.cookie = cookie;
    }
    await writeFile(resolve(site.directory, 'admin.json'), JSON.stringify(await hashPassword('replacement-owner-password-2026')));
    assert.equal((await site.request('/api/profile', { method: 'PUT', cookie: adminCookie, body: { name: 'Revoked owner session' } })).status, 401);
    assert.equal((await (await site.request('/api/session', { cookie: bob.cookie })).json()).user.id, bob.user.id);
    assert.equal((await site.request(`/api/photos/${bobPhoto.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 200);
    assert.equal((await site.request(bobPhoto.src)).status, 404);
    assert.equal((await publicLibrary('bob_lens')).photos.length, 0);
    assert.equal((await site.request(alicePhoto.src)).status, 200);
    assert.equal((await site.request(ownerPhoto.src)).status, 200);
  } finally { await site.dispose(); }
});

test('self-service registration works without owner setup and duplicate registrations are atomic', async () => {
  const site = await fixture();
  try {
    const anonymous = await (await site.request('/api/session')).json();
    assert.equal(anonymous.configured, false);
    assert.equal(anonymous.user, null);
    const registrations = await Promise.all(['concurrent_user', 'CONCURRENT_USER'].map(username => site.request('/api/register', {
      method: 'POST', body: { username, name: 'Concurrent User', password: 'concurrent-password-2026' },
    })));
    assert.deepEqual(registrations.map(response => response.status).sort(), [201, 409]);
    const accepted = registrations.find(response => response.status === 201);
    const session = await (await site.request('/api/session', { cookie: sessionCookie(accepted) })).json();
    assert.equal(session.user.username, 'concurrent_user');
    const library = await (await site.request('/api/library?user=concurrent_user')).json();
    assert.equal(library.owner.id, session.user.id);
    assert.equal(library.photos.length, 0);
    assert.equal((await site.request('/api/register', { method: 'POST', body: { username: 'cross_origin', name: 'Rejected', password: 'cross-origin-password' }, headers: { Origin: 'https://other.invalid' } })).status, 403);
    assert.equal((await site.request('/api/library?user=cross_origin')).status, 404);
    assert.equal((await site.request('/api/profile', { method: 'PUT', body: { name: 'Anonymous' } })).status, 401);
  } finally { await site.dispose(); }
});

test('registration validates account names and password length', async () => {
  for (const username of ['ab', '1photographer', '../photos', 'bad name', 'a'.repeat(25), 'admin']) {
    const site = await fixture();
    try {
      const response = await site.request('/api/register', { method: 'POST', body: { username, name: 'Invalid account', password: 'validation-password-2026' } });
      assert.ok([400, 409].includes(response.status), `Invalid username ${username} must be rejected, got ${response.status}`);
    } finally { await site.dispose(); }
  }
  for (const password of ['short', 'x'.repeat(257)]) {
    const site = await fixture();
    try {
      const response = await site.request('/api/register', { method: 'POST', body: { username: 'valid_name', name: 'Invalid password', password } });
      assert.equal(response.status, 400);
      assert.equal((await site.request('/api/library?user=valid_name')).status, 404);
    } finally { await site.dispose(); }
  }
});

test('registration attempts are rate limited', async () => {
  const site = await fixture();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await site.request('/api/register', { method: 'POST', body: { username: 'ab', password: 'validation-password-2026' } })).status, 400);
    }
    assert.equal((await site.request('/api/register', { method: 'POST', body: { username: 'valid_name', password: 'validation-password-2026' } })).status, 429);
    assert.equal((await site.request('/api/library?user=valid_name')).status, 404);
  } finally { await site.dispose(); }
});
