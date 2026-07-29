// deploy.mjs
// Despliegue completo del proyecto en un solo paso:
//   1. Comprueba que los scopes de shopify.app.toml y fly.toml coinciden.
//   2. fly deploy        → sube el backend (primero, para que la nueva versión
//                          de la app apunte a un servidor que ya responde).
//   3. shopify app deploy → crea la versión nueva en Shopify y la publica, de
//                          forma que la tienda recibe los cambios de config,
//                          scopes y webhooks sin desinstalar la app.
//
// Se puede lanzar a mano (`npm run deploy`) o desde el hook pre-push.
// Variables de entorno opcionales: SKIP_FLY=1, SKIP_SHOPIFY=1.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = (msg) => console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✖ ${msg}\x1b[0m\n`);
  process.exit(1);
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function read(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

// Salida de un comando de git, o "" si falla (no queremos romper el deploy por
// no poder leer metadatos).
function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

function run(command, args, extraEnv = {}) {
  // shell: true para que en Windows se resuelvan los shims .cmd de fly/shopify.
  const res = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) fail(`No se ha podido ejecutar "${command}": ${res.error.message}`);
  if (res.status !== 0) fail(`"${command} ${args.join(' ')}" ha terminado con código ${res.status}.`);
}

// ─── 1. Scopes en sincronía ─────────────────────────────────────────────────
// shopify.app.toml es la fuente de verdad (config declarativa). fly.toml expone
// los mismos scopes como env SCOPES, que es lo que lee shopify.server.js para
// detectar que una tienda tiene permisos antiguos y pedirle los nuevos. Si no
// coinciden, la tienda se queda con los permisos viejos y las llamadas fallan.
function checkScopes() {
  const appToml = read('shopify.app.toml');
  const flyToml = read('fly.toml');

  const declared = appToml.match(/^\s*scopes\s*=\s*"([^"]*)"/m)?.[1];
  const deployed = flyToml.match(/^\s*SCOPES\s*=\s*['"]([^'"]*)['"]/m)?.[1];

  if (!declared) fail('No he encontrado "scopes" en [access_scopes] de shopify.app.toml.');
  if (!deployed) fail('No he encontrado "SCOPES" en [env] de fly.toml.');

  const normalize = (value) =>
    value.split(',').map((s) => s.trim()).filter(Boolean).sort();

  const a = normalize(declared);
  const b = normalize(deployed);

  if (a.join(',') !== b.join(',')) {
    const soloToml = a.filter((s) => !b.includes(s));
    const soloFly = b.filter((s) => !a.includes(s));
    fail(
      [
        'Los scopes de shopify.app.toml y fly.toml no coinciden.',
        soloToml.length ? `  Faltan en fly.toml:        ${soloToml.join(', ')}` : null,
        soloFly.length ? `  Sobran en fly.toml:        ${soloFly.join(', ')}` : null,
        '',
        'Corrige la línea de [env] en fly.toml y vuelve a lanzarlo:',
        `  SCOPES = '${declared}'`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  log(`Scopes en sincronía (${a.length}): ${declared}`);
}

// ─── 2. Metadatos de la versión ─────────────────────────────────────────────
// Nombre único y legible por fecha, para localizar la versión en el Partner
// Dashboard: 20260729-1432-a1b2c3d
function versionName(sha) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return sha ? `${stamp}-${sha}` : stamp;
}

// URL del commit en GitHub, admitiendo remotos https y ssh.
function sourceControlUrl(sha) {
  const remote = git(['remote', 'get-url', 'origin']);
  if (!remote || !sha) return null;
  const repo = remote
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  return repo.startsWith('https://github.com/') ? `${repo}/commit/${sha}` : null;
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

checkScopes();

const sha = git(['rev-parse', '--short', 'HEAD']);
const subject = git(['log', '-1', '--pretty=%s']);
const dirty = git(['status', '--porcelain']);

if (dirty) {
  console.warn(
    '\n\x1b[33m⚠ Hay cambios sin commitear: fly deploy sube el código del disco,' +
      '\n  no el del último commit, así que lo que se despliegue no coincidirá' +
      '\n  exactamente con el commit registrado en la versión.\x1b[0m',
  );
}

if (process.env.SKIP_FLY === '1') {
  log('SKIP_FLY=1 → me salto fly deploy');
} else {
  log('fly deploy — subiendo el backend');
  run('fly', ['deploy']);
}

if (process.env.SKIP_SHOPIFY === '1') {
  log('SKIP_SHOPIFY=1 → me salto shopify app deploy');
} else {
  const version = versionName(sha);
  const url = sourceControlUrl(sha);

  // --allow-updates: crea y publica la versión sin preguntar (es el flag que
  // recomienda el CLI para entornos no interactivos). No usamos
  // --allow-deletes: si un deploy va a borrar config o extensiones, preferimos
  // que falle y mirarlo a mano.
  const args = ['app', 'deploy', '--allow-updates', '--version', version];
  if (url) args.push('--source-control-url', url);

  log(`shopify app deploy — creando y publicando la versión ${version}`);
  run('shopify', args, subject ? { SHOPIFY_FLAG_MESSAGE: subject } : {});
}

console.log('\n\x1b[32m✔ Deploy completado. La tienda ya tiene la versión nueva.\x1b[0m');
console.log(
  '\x1b[2m  Si has añadido scopes, la tienda pedirá aceptar los permisos nuevos\n' +
    '  al abrir la app. No hace falta desinstalarla.\x1b[0m\n',
);
