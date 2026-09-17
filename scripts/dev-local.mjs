import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const selected = process.argv[2];
if (!['next', 'vinext'].includes(selected)) throw new Error('Choose next or vinext');
const directory = new URL('../node_modules/' + selected + '/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8'));
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[selected];
const args = selected === 'next' ? ['dev', '--hostname', '127.0.0.1'] : ['dev', '--hostname', '127.0.0.1', '--port', '3000'];
const child = spawn(process.execPath, [fileURLToPath(new URL(bin, directory)), ...args, ...process.argv.slice(3)], {
  stdio: 'inherit', env: { ...process.env, APP_ENV: 'development', SJN_DEV_BINDINGS: '1' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
