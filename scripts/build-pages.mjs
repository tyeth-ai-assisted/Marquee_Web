import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '_site');
let worker = process.env.ALBUM_WORKER_URL || '';
if (worker) {
  const url = new URL(worker);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ALBUM_WORKER_URL must be an HTTPS origin without credentials, path, query or fragment.');
  }
  worker = url.origin;
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'public'), output, { recursive: true });
await rm(resolve(output, 'CNAME'), { force: true });
await writeFile(resolve(output, '.nojekyll'), '');
// ALBUM_WORKER_URL overrides the importer default committed in public/js/core/deployment.js.
if (worker)
  await writeFile(resolve(output, 'js/core/deployment.js'),
    `// Public deployment settings; no credentials.\nexport const albumWorkerUrl = ${JSON.stringify(worker)};\n`);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(resolve(output, 'build.json'), JSON.stringify({
  sha, repository: process.env.GITHUB_REPOSITORY || 'tyeth-ai-assisted/Marquee_Web',
  builtAt: new Date().toISOString(), albumImporterConfigured: true,
}, null, 2) + '\n');
console.log(`Prepared GitHub Pages files for ${sha.slice(0, 12)} (${worker ? 'with' : 'without'} an album importer default).`);
