import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.mjs';

// Interactive only: no password in command arguments, source or terminal output.
function promptSecret(label) {
  if (!process.stdin.isTTY) throw new Error('请在本机交互式终端运行 npm run admin:password');
  process.stdout.write(label);
  return new Promise((resolveInput, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const finish = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('已取消')); return; }
        if (char === '\r' || char === '\n') { finish(); resolveInput(value); return; }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
try {
  const password = await promptSecret('设置管理员密码（至少 12 个字符，输入不回显）：');
  const again = await promptSecret('再次输入：');
  if (password !== again) throw new Error('两次密码不一致，未修改密码');
  const credentials = await hashPassword(password);
  const directory = resolve(process.env.PORTFOLIO_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, 'admin.json.tmp'), JSON.stringify(credentials), { mode: 0o600 });
  await rename(resolve(directory, 'admin.json.tmp'), resolve(directory, 'admin.json'));
  console.log('管理员密码已保存。运行 npm start 后访问 /admin.html 登录。修改密码会使旧会话失效。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
