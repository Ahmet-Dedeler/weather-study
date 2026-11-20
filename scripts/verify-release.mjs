import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const source = [
  /^(?:\.gitignore|LICENSE|README\.md|index\.html|package(?:-lock)?\.json|tsconfig\.json|vite\.config\.ts)$/,
  /^\.github\/workflows\/check\.yml$/,
  /^scripts\/verify-release\.mjs$/,
  /^assets\/(?:logo\.svg|(?:daylight|lightning|social-preview)\.jpg)$/,
  /^src\/(?:App\.tsx|main\.tsx|index\.css|engine\/[a-zA-Z]+\.ts)$/,
];
const build = /^(?:index\.html|assets\/(?:index-[\w-]+\.(?:js|css)|logo-[\w-]+\.svg))$/;
const privatePatterns = [
  /\/(?:Users|home)\/[\w.-]+\/|[A-Z]:\\Users\\|file:\/\/\//i,
  /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [\w ]*PRIVATE KEY-----/,
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
];

function checkScreenshot(path, bytes) {
  if (bytes.length < 4 || bytes.length > 1024 * 1024 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new Error(`Expected a JPEG under 1 MB: ${path}`);
  }
  for (let offset = 2; offset + 4 <= bytes.length;) {
    const marker = bytes.readUInt16BE(offset);
    if (marker === 0xffda) return; // Start of image data.
    const length = bytes.readUInt16BE(offset + 2);
    if (marker < 0xffc0 || (marker >= 0xffe1 && marker <= 0xffef) || marker === 0xfffe ||
        length < 2 || offset + 2 + length > bytes.length) {
      throw new Error(`Unexpected JPEG segment or embedded metadata: ${path}`);
    }
    if (marker === 0xffe0 && (length !== 16 || bytes.toString('ascii', offset + 4, offset + 9) !== 'JFIF\0')) {
      throw new Error(`Unexpected JPEG application header: ${path}`);
    }
    offset += 2 + length;
  }
  throw new Error(`Missing JPEG image data: ${path}`);
}

function check(base, paths, allowed) {
  for (const path of paths) {
    if (!allowed.some((pattern) => pattern.test(path))) throw new Error(`Unexpected release file: ${base}${path}`);
    const bytes = readFileSync(`${base}${path}`);
    if (!base && path.endsWith('.jpg')) {
      checkScreenshot(path, bytes);
      continue;
    }
    if (bytes.includes(0)) throw new Error(`Unexpected binary: ${base}${path}`);
    const text = bytes.toString('utf8');
    if (privatePatterns.some((pattern) => pattern.test(text))) throw new Error(`Review potential private content: ${base}${path}`);
  }
}

const tracked = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!tracked.length) throw new Error('Stage the source files before running the release audit');
for (const entry of tracked) {
  const match = /^100(?:644|755) (\w+) 0\t(.+)$/.exec(entry);
  if (!match) throw new Error('Symlinks, submodules, and unresolved entries are not allowed');
  const [, blob, path] = match;
  if (!source.some((pattern) => pattern.test(path))) throw new Error(`Unexpected source: ${path}`);
  if (!readFileSync(path).equals(execFileSync('git', ['cat-file', 'blob', blob]))) {
    throw new Error(`Build input differs from the staged file: ${path}`);
  }
}
check('', tracked.map((entry) => entry.split('\t')[1]), source);
const output = readdirSync('dist', { recursive: true, withFileTypes: true });
for (const entry of output) {
  if (entry.isDirectory() && entry.parentPath === 'dist' && entry.name === 'assets') continue;
  if (!entry.isFile()) throw new Error(`Unexpected build entry: ${entry.parentPath}/${entry.name}`);
  check('dist/', [`${entry.parentPath === 'dist' ? '' : 'assets/'}${entry.name}`], [build]);
}
if (!output.some((entry) => entry.parentPath === 'dist' && entry.name === 'index.html')) throw new Error('Missing build entrypoint');
console.log('Release audit passed: source, approved artwork, and static app bundle.');
