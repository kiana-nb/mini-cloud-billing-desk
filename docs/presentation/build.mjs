// Builds docs/presentation/presentation.pdf from slides.template.html and the Mermaid
// sources in docs/diagrams, so the slides always show the same diagrams as the repo.
//   node docs/presentation/build.mjs
// Needs a Chromium-based browser (Edge or Chrome); set BROWSER to its path if it is not found.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const outDir = join(here, 'build');
mkdirSync(outDir, { recursive: true });

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let html = readFileSync(join(here, 'slides.template.html'), 'utf8').replace(/<!-- diagram:([\w-]+) -->/g, (_, name) => {
  const source = readFileSync(join(root, 'docs', 'diagrams', `${name}.mmd`), 'utf8');
  return `<pre class="mermaid" data-name="${name}">${escape(source)}</pre>`;
});

const mermaid = pathToFileURL(join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')).href;
html = html.replace(
  '</body>',
  `<script src="${mermaid}"></script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose',
    flowchart: { useMaxWidth: true }, sequence: { useMaxWidth: true, mirrorActors: false }, er: { useMaxWidth: true } });
  (async () => {
    // one diagram at a time, so a broken one is named instead of stopping the rest
    const blocks = [...document.querySelectorAll('pre.mermaid')];
    for (const [i, el] of blocks.entries()) {
      try {
        const { svg } = await mermaid.render('diagram' + i, el.textContent);
        const box = document.createElement('div');
        box.className = 'mm';
        box.innerHTML = svg;
        el.replaceWith(box);
      } catch (err) {
        el.outerHTML = '<p class="mm-error">DIAGRAM ERROR ' + el.dataset.name + ': ' + (err && err.message ? err.message : err) + '</p>';
      }
    }
    document.body.dataset.ready = 'yes';
  })();
</script>
</body>`,
);
const htmlPath = join(outDir, 'slides.html');
writeFileSync(htmlPath, html);

const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) throw new Error('No Chromium-based browser found; set BROWSER=/path/to/chrome');

const pdf = join(here, 'presentation.pdf');
execFileSync(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-pdf-header-footer',
  '--allow-file-access-from-files',
  '--virtual-time-budget=30000',
  `--print-to-pdf=${pdf}`,
  pathToFileURL(htmlPath).href,
], { stdio: 'inherit' });
console.log(`wrote ${pdf}`);
