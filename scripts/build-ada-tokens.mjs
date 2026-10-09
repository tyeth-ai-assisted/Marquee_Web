#!/usr/bin/env node
/**
 * Builds the Adafruit design-system tokens into public/css/vendor/ada/.
 *
 * The package installs from GitHub without its dist/ (dist is gitignored upstream
 * and there is no `prepare` script), and it does not ship its own build.mjs either,
 * so this repeats that build against the installed token JSON. The output is
 * committed: the site is deployed as plain files with no install step, the same way
 * js/vendor/ holds Konva and esptool-js.
 *
 *   npm run tokens
 *
 * Keep the platforms and selectors in step with the package's build.mjs. Only the
 * CSS outputs are built; Marquee has no use for the SCSS and JSON ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import StyleDictionary from 'style-dictionary';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'node_modules', '@adafruit', 'design-system');
const OUT = path.join(ROOT, 'public', 'css', 'vendor', 'ada') + '/';

const { version } = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const tok = (f) => path.join(PKG, 'tokens', f);
const BASE_SOURCE = ['primitive.json', 'semantic.json', 'component.json', 'marketing.json'].map(tok);

await new StyleDictionary({
  source: BASE_SOURCE,
  usesDtcg: true,
  platforms: {
    css: { transformGroup: 'css', prefix: 'ada', buildPath: OUT,
      files: [{ destination: 'tokens.css', format: 'css/variables', options: { outputReferences: true, selector: ':root' } }] },
  },
}).buildAllPlatforms();

// A mode redefines only its own tokens, emitted under `selector`. Primitives are
// included so references resolve, then filtered back out of the output.
for (const [file, destination, selector] of [
  ['theme-dark.json',      'dark.css',    ':root[data-theme="dark"], .dark-mode'],
  ['density-compact.json', 'compact.css', '[data-density="compact"]'],
]) {
  await new StyleDictionary({
    source: [tok('primitive.json'), tok(`modes/${file}`)],
    usesDtcg: true,
    platforms: {
      css: { transformGroup: 'css', prefix: 'ada', buildPath: OUT + 'modes/',
        files: [{ destination, format: 'css/variables',
          filter: (token) => token.filePath.endsWith(file),
          options: { outputReferences: true, selector } }] },
    },
  }).buildAllPlatforms();
}

// The package's "match my system" theme: the same dark declarations inside the OS query.
const darkPath = OUT + 'modes/dark.css';
const darkCss = fs.readFileSync(darkPath, 'utf8');
const darkBody = darkCss.slice(darkCss.indexOf('{') + 1, darkCss.lastIndexOf('}'));
fs.writeFileSync(darkPath, `${darkCss.trimEnd()}\n\n@media (prefers-color-scheme: dark) {\n  html[data-theme="system"] {${darkBody.replace(/\n/g, '\n  ')}}\n}\n`);

// The golden snippets Marquee uses, verbatim and in one file so index.html loads them
// with a single <link>. Marquee's own sizing on top of them lives in css/base.css.
const COMPONENTS = [
  'utilities', 'button', 'field', 'form-field', 'select', 'textarea', 'checkbox-radio',
  'card', 'dialog', 'badge', 'chip', 'progress-bar', 'alert', 'dropdown', 'table', 'link', 'code',
];
fs.writeFileSync(OUT + 'components.css',
  `/* @adafruit/design-system ${version} golden snippets (examples/*.css), concatenated\n` +
  `   by scripts/build-ada-tokens.mjs. Do not edit — run \`npm run tokens\`. */\n` +
  COMPONENTS.map((c) => `\n/* ---- examples/${c}.css ---- */\n` +
    fs.readFileSync(path.join(PKG, 'examples', `${c}.css`), 'utf8')).join(''));

fs.writeFileSync(OUT + 'VERSION', `@adafruit/design-system ${version}\n`);
console.log(`\n✓ @adafruit/design-system ${version} tokens + ${COMPONENTS.length} snippets → public/css/vendor/ada/`);
