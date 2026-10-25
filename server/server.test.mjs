import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createPortfolioServer } from './index.mjs';
import { hashPassword } from './auth.mjs';

test('visitor isolation, admin writes, shared data, persistence and revocation', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'portfolio-auth-test-'));
  let server;
  const port = 43173;
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
