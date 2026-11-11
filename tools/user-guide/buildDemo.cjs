// Embed the current card components and a local-only playground into the guide.
// Run from any directory: node tools/user-guide/buildDemo.cjs
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const guidePath = path.join(root, 'docs/korisnicke-upute-dashboard.html');
let html = fs.readFileSync(guidePath, 'utf8');
const block = (name, content) => `<!-- GUIDE-DEMO:${name}:START -->\n${content}\n<!-- GUIDE-DEMO:${name}:END -->`;
function inject(name, content, anchor) {
  const expression = new RegExp(`<!-- GUIDE-DEMO:${name}:START -->[\\s\\S]*?<!-- GUIDE-DEMO:${name}:END -->`);
  const next = block(name, content);
  if (expression.test(html)) html = html.replace(expression, () => next);
  else {
    if (!html.includes(anchor)) throw new Error(`Missing guide anchor: ${anchor}`);
    html = html.replace(anchor, () => next + '\n' + anchor);
  }
}
const css = read('dashboard/public/devices/deviceCards.css') + '\n' + read('tools/user-guide/demo.css');
inject('styles', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">\n<style>\n${css}\n</style>`, '</head>');
inject('playground', read('tools/user-guide/demo.html'), '    <section class="section" id="pocetak">');
const sources = ['widgetGrouping', 'deviceModel', 'deviceCards'].map(name => read(`dashboard/public/devices/${name}.js`));
const fixture = JSON.stringify(JSON.parse(read('tools/user-guide/fixture.json'))).replace(/</g, '\\u003c');
const script = sources.join('\n;\n') + '\n;\n' + read('tools/user-guide/demo.js');
inject('scripts', `<script type="application/json" id="guide-demo-data">${fixture}</script>\n<script>\n${script.replace(/<\/script/gi, '<\\/script')}\n</script>`, '</body>');
if (!html.includes('class="guide-demo-nav"')) {
  html = html.replace('<nav id="sadrzaj">', '<nav id="sadrzaj"><a class="guide-demo-nav" href="#isprobaj"><span>▶</span>Isprobaj dashboard</a>');
  html = html.replace('<nav aria-label="Sadrzaj na manjem zaslonu">', '<nav aria-label="Sadrzaj na manjem zaslonu"><a href="#isprobaj">▶ Isprobaj dashboard</a>');
  html = html.replace('<div class="meta">', '<a class="guide-demo-cta" href="#isprobaj">Isprobaj interaktivni demo <span aria-hidden="true">↗</span></a><div class="meta">');
}
const shortcuts = {
  pregled: ['filter', 'Isprobaj pretragu i odabir prostorije'],
  upravljanje: ['controls', 'Isprobaj kontrole na stvarnim karticama'],
  oznake: ['offline', 'Isprobaj prekid veze i oznake stanja'],
  kartice: ['settings', 'Isprobaj preimenovanje i postavke kartice'],
  prostorije: ['rooms', 'Isprobaj dodavanje prostorije'],
  premjestanje: ['move', 'Isprobaj grupno premještanje'],
  osvjezavanje: ['refresh', 'Isprobaj osvježavanje i pauzu'],
  trendovi: ['trend', 'Isprobaj pregled demo trenda'],
  alarmi: ['alarm', 'Isprobaj pregled demo alarma'],
};
for (const [section, [action, label]] of Object.entries(shortcuts)) {
  const name = `shortcut-${section}`;
  const content = `<button type="button" class="guide-demo-link" data-demo-launch="${action}">▶ ${label}</button>`;
  if (html.includes(`GUIDE-DEMO:${name}:START`)) inject(name, content, '');
  else html = html.replace(new RegExp(`(<section class="section" id="${section}">[\\s\\S]*?<\/h2>)`), (_, heading) => heading + block(name, content));
}
fs.writeFileSync(guidePath, html, 'utf8');
console.log(`Updated ${path.relative(root, guidePath)} (${Buffer.byteLength(html)} bytes); all assets embedded.`);
