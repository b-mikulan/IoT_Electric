// Standalone guide only. No API client, network calls or persistent storage.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const initial = JSON.parse($('guide-demo-data').textContent);
  const clone = value => JSON.parse(JSON.stringify(value));
  let data, cards, scenario = 'connected', paused = false, ticks = 0, generation = 0;
  let lastRead, activeLesson = '', dialogReturnFocus;
  const done = new Set();
  const dialog = $('demo-dialog'), content = $('demo-dialog-content');
  const instructions = {
    filter: 'Upiši AC309 u pretragu ili otvori „Kat i prostorija” i odaberi prostoriju. Obriši pretragu za povratak na sve kartice.',
    controls: 'Na L3307 promijeni svjetlinu ili na AC309 temperaturu tipkama + / −. „Simulirano” je tvoj odabir; glavno očitanje ostaje odvojeno.',
    settings: 'Otvori zupčanik na kartici, promijeni naziv ili glavno očitanje i spremi. Novi prikaz vidiš odmah.',
    move: 'Klikni „Odaberi uređaje”, označi jednu ili više kartica i odaberi „Premjesti”. ACX01 je primjer uređaja bez prostorije.',
    offline: 'U „Isprobaj stanje” odaberi „Prekid veze”. Pogledaj zadržana očitanja i onemogućene kontrole, pa vrati urednu vezu.',
  };
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function feedback(text, error = false) {
    $('demo-feedback').textContent = text;
    $('demo-feedback').dataset.error = String(error);
  }
  function complete(name) {
    done.add(name);
    document.querySelector(`[data-lesson="${name}"]`).dataset.done = 'true';
    $('demo-progress').textContent = `${done.size} / 5 isprobano`;
  }
  function chooseLesson(name) {
    activeLesson = name;
    for (const button of document.querySelectorAll('[data-lesson]')) button.setAttribute('aria-pressed', String(button.dataset.lesson === name));
    $('demo-instruction').textContent = instructions[name];
  }
  function paintHeader() {
    $('demo-connection').textContent = scenario === 'offline' ? 'Simulirani prekid veze' : paused ? 'Demo osvježavanje pauzirano' : 'Demo očitanja dostupna';
    $('demo-read-at').textContent = `Zadnja demo provjera: ${new Date(lastRead).toLocaleTimeString('hr-HR')}`;
    $('demo-pause').textContent = paused ? 'Nastavi osvježavanje' : 'Pauziraj';
    $('demo-pause').setAttribute('aria-pressed', String(paused));
  }
  function update() {
    for (const point of data.widgets) point.state = scenario === 'forced' && /\/L3307\//.test(point.id) ? 2 : 0;
    cards.update({ ...data, deviceSettings: data.deviceSettings, demo: true, status: scenario === 'offline' ? 'error' : 'connected', readAt: lastRead, settingsEnabled: true, roomEditingEnabled: true });
    paintHeader();
  }
  function pointsFor(target) {
    if (!target || target.scope === 'all') return data.widgets;
    const devices = cards.getDevices().filter(device => target.scope === 'device' ? device.key === target.id : target.scope === 'room' ? (device.room?.id || null) === target.id : target.scope === 'floor' ? (device.room?.floorId || null) === target.id : true);
    const keys = new Set(devices.map(device => device.key));
    return data.widgets.filter(point => keys.has(IoTWidgetGrouping.deriveWidgetGrouping(point.id).key));
  }
  async function refresh(target = { scope: 'all' }) {
    const version = generation;
    await new Promise(resolve => setTimeout(resolve, 350));
    if (version !== generation) throw new Error('Demo je vraćen na početno stanje.');
    if (scenario === 'offline') throw new Error('Simulirani prekid veze. Vrati „Uredna veza” i pokušaj ponovno.');
    const points = pointsFor(target);
    ticks++;
    for (const point of points) {
      if (/\/RmTmp$/.test(point.id)) point.value = Math.round((22.4 + Math.sin(ticks / 3) * 0.6) * 10) / 10;
      if (/\/LtLvl$/.test(point.id)) point.value = 220 + (ticks % 6) * 11;
      if (/\/OccSts$/.test(point.id)) point.value = ticks % 2;
    }
    const readAt = new Date().toISOString();
    // As in the dashboard, a scoped refresh does not advance the global clock.
    if (target.scope === 'all') lastRead = readAt;
    cards.updateValues({ widgets: points, status: 'connected', readAt });
    paintHeader();
    return { readAt, pointCount: points.length, errorCount: 0 };
  }
  function showDialog(title) {
    dialogReturnFocus = document.activeElement;
    $('demo-dialog-title').textContent = title;
    content.replaceChildren();
    dialog.showModal();
  }
  function closeDialog() { dialog.close(); }
  dialog.addEventListener('close', () => { if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus(); });
  $('demo-dialog-close').addEventListener('click', closeDialog);
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });
  function field(form, label, id, element) {
    const caption = node('label', label); caption.htmlFor = id; element.id = id;
    form.append(caption, element); return element;
  }
  function select(options, selected) {
    const input = node('select');
    for (const [value, label] of options) { const option = node('option', label); option.value = value; input.append(option); }
    input.value = selected ?? ''; return input;
  }
  function roomOptions() {
    return [['', 'Bez prostorije'], ...data.roomDetails.map(room => [room.id, [room.name, data.floors.find(floor => floor.id === room.floorId)?.name].filter(Boolean).join(' · ')])];
  }
  function actions(form, label) {
    const row = node('div', undefined, 'demo-actions');
    const cancel = node('button', 'Odustani'); cancel.type = 'button'; cancel.addEventListener('click', closeDialog);
    const save = node('button', label, 'demo-primary'); save.type = 'submit'; row.append(cancel, save); form.append(row);
  }
  function settingFor(key) {
    let setting = data.deviceSettings.find(item => item.key === key);
    if (!setting) { setting = { key }; data.deviceSettings.push(setting); }
    return setting;
  }
  function openSettings(device) {
    showDialog(`Postavke kartice · ${device.label}`);
    const form = node('form');
    const name = field(form, 'Naziv kartice', 'demo-device-name', node('input'));
    name.value = device.label; name.required = true; name.maxLength = 80;
    const room = field(form, 'Prostorija', 'demo-device-room', select(roomOptions(), device.room?.id));
    const available = [...new Map([...(device.primary || []), ...Object.values(device.roles)].filter(point => point.importance === 'primary').map(point => [point.id, point])).values()];
    const metric = field(form, 'Glavno očitanje', 'demo-device-metric', select([['', 'Automatski'], ...available.map(point => [point.id, point.label])], settingFor(device.key).primaryPointId));
    form.append(node('p', 'Promijeni prikaz, a zatim otvori karticu i usporedi rezultat.', 'demo-small'));
    actions(form, 'Spremi u demu'); content.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!name.value.trim()) { name.setCustomValidity('Upiši naziv kartice.'); name.reportValidity(); return; }
      const setting = settingFor(device.key);
      // Empty string intentionally suppresses automatic room assignment.
      Object.assign(setting, { label: name.value.trim(), room: room.value, primaryPointId: metric.value || null, primaryUnit: null });
      update(); closeDialog(); complete('settings'); feedback(`Spremljena demo kartica „${setting.label}”. Pretraga sada pronalazi i novi naziv.`);
    });
    name.addEventListener('input', () => name.setCustomValidity(''));
    name.focus();
  }
  function openRooms() {
    showDialog('Prostorije u demu');
    const list = node('ul'); for (const [, label] of roomOptions().slice(1)) list.append(node('li', label)); content.append(list);
    const form = node('form');
    const name = field(form, 'Naziv nove prostorije', 'demo-room-name', node('input')); name.required = true; name.maxLength = 70;
    const floor = field(form, 'Kat / grupa', 'demo-room-floor', select(data.floors.map(item => [item.id, item.name]), data.floors[0]?.id));
    const error = node('p', '', 'demo-error'); error.setAttribute('role', 'alert'); form.append(error);
    actions(form, 'Dodaj prostoriju'); content.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); const label = name.value.trim();
      if (!label) { error.textContent = 'Upiši naziv prostorije.'; return; }
      if (data.roomDetails.some(room => room.name.toLocaleLowerCase('hr') === label.toLocaleLowerCase('hr') && room.floorId === floor.value)) { error.textContent = 'Prostorija s tim nazivom već postoji na odabranom katu.'; return; }
      const id = `demo-room-${data.roomDetails.length + 1}`;
      data.roomDetails.push({ id, name: label, floorId: floor.value }); data.rooms.push(id); update(); closeDialog();
      feedback(`Dodana prostorija „${label}”. Sada u nju možeš premjestiti uređaje.`);
    }); name.focus();
  }
  function openMove(devices) {
    showDialog('Premjesti odabrane uređaje');
    content.append(node('p', devices.map(device => device.label).join(', '), 'demo-small'));
    const form = node('form');
    const room = field(form, 'Odredišna prostorija', 'demo-move-room', select(roomOptions(), data.roomDetails[0]?.id));
    actions(form, 'Premjesti u demu'); content.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); for (const device of devices) settingFor(device.key).room = room.value;
      update(); cards.clearSelection(); closeDialog(); complete('move'); feedback(`Premješteno uređaja: ${devices.length}. Ako je aktivan filter stare prostorije, odaberi „Svi uređaji” da ih ponovno vidiš.`);
    }); room.focus();
  }
  function renderTrend() {
    const week = $('demo-period').value === 'week';
    const values = week ? [21.8, 22.3, 23.1, 22.7, 22.2, 21.9, 22.4] : [21.8, 21.6, 21.9, 22.4, 23.1, 23.5, 22.8, 22.4];
    const labels = week ? ['Prije 6 dana', 'Prije 5 dana', 'Prije 4 dana', 'Prije 3 dana', 'Prekjučer', 'Jučer', 'Danas'] : ['−24 h', '−21 h', '−18 h', '−15 h', '−12 h', '−9 h', '−6 h', 'Sada'];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 340 160'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Izmišljeni trend temperature AC309, ${week ? '7 dana' : '24 sata'}, od ${Math.min(...values)} do ${Math.max(...values)} °C. Vrijednosti su dostupne u tablici.`);
    const part = (tag, attributes, text) => { const item = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value); if (text) item.textContent = text; svg.append(item); return item; };
    for (const value of [21, 22, 23, 24]) { const y = 130 - (value - 21) * 35; part('line', { x1: 38, x2: 325, y1: y, y2: y, stroke: '#dce8e2' }); part('text', { x: 3, y: y + 4, fill: '#647771', 'font-size': 10 }, `${value} °C`); }
    const points = values.map((value, index) => [38 + index * 287 / (values.length - 1), 130 - (value - 21) * 35]);
    part('polyline', { points: points.map(point => point.join(',')).join(' '), fill: 'none', stroke: '#008577', 'stroke-width': 2.5, 'stroke-linejoin': 'round' });
    points.forEach(([cx, cy], i) => { const circle = part('circle', { cx, cy, r: 4, fill: '#008577' }); const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${labels[i]}: ${values[i]} °C`; circle.append(title); });
    part('text', { x: 38, y: 153, fill: '#647771', 'font-size': 10 }, labels[0]); part('text', { x: 325, y: 153, 'text-anchor': 'end', fill: '#647771', 'font-size': 10 }, labels.at(-1));
    $('demo-trend-chart').replaceChildren(svg);
    const format = value => value.toLocaleString('hr-HR', { maximumFractionDigits: 1 });
    $('demo-trend-summary').textContent = `Min. ${format(Math.min(...values))} °C · Max. ${format(Math.max(...values))} °C · Prosjek ${format(values.reduce((a,b) => a+b) / values.length)} °C`;
    $('demo-trend-table').replaceChildren(...values.map((value, i) => { const tr = node('tr'); tr.append(node('td', labels[i]), node('td', `${format(value)} °C`)); return tr; }));
  }
  function renderAlarms() {
    const alarms = [{ state: 'active', title: 'AC309 · Provjera filtra', text: 'Izmišljeni aktivni alarm održavanja. U stvarnom sustavu pročitaj poruku i obavijesti odgovornu osobu.', time: 'Danas, 09:15' }, { state: 'resolved', title: 'L3307 · Povratak očitanja', text: 'Izmišljeni primjer završene poteškoće s očitanjem. Završeni zapis ostaje u povijesti.', time: 'Jučer, 16:40' }];
    const filter = $('demo-alarm-filter').value;
    $('demo-alarm-list').replaceChildren(...alarms.filter(alarm => filter === 'all' || filter === alarm.state).map(alarm => {
      const details = node('details', undefined, 'demo-alarm'), summary = node('summary');
      summary.append(node('span', alarm.state === 'active' ? 'Aktivan' : 'Završen', `badge ${alarm.state === 'active' ? 'yellow' : 'green'}`), node('span', alarm.title));
      details.append(summary, node('p', `${alarm.time} · ${alarm.text}`)); return details;
    }));
  }
  function reset() {
    generation++; cards?.destroy(); data = clone(initial); scenario = 'connected'; paused = false; ticks = 0; lastRead = new Date().toISOString(); done.clear(); activeLesson = '';
    cards = IoTDeviceCards.create({ container: $('demo-cards'), onSettings: openSettings, onRooms: openRooms, onMove: openMove, onRefresh: refresh });
    $('demo-state').value = scenario; $('demo-period').value = 'day'; $('demo-alarm-filter').value = 'all';
    for (const button of document.querySelectorAll('[data-lesson]')) { delete button.dataset.done; button.setAttribute('aria-pressed', 'false'); }
    $('demo-progress').textContent = '0 / 5 isprobano'; $('demo-instruction').textContent = 'Kreni od bilo koje vježbe ili slobodno istraži kartice.';
    update(); renderTrend(); renderAlarms(); feedback('Početno stanje. Sve kontrole mijenjaju samo lokalni demo.');
  }
  $('demo-state').addEventListener('change', event => {
    scenario = event.target.value; update();
    if (scenario === 'offline') { complete('offline'); feedback('Prekid veze: posljednja očitanja ostaju vidljiva, upravljanje je onemogućeno. Vrati urednu vezu za nastavak.', true); }
    else if (scenario === 'forced') feedback('L3307 je forsiran: njegova je kontrola zaključana, dok ostale kartice rade normalno.', true);
    else feedback('Veza je ponovno dostupna. Kontrole možeš nastaviti isprobavati.');
  });
  $('demo-pause').addEventListener('click', () => { paused = !paused; paintHeader(); feedback(paused ? 'Automatsko osvježavanje je pauzirano. Ručna provjera i kontrole i dalje su dostupne.' : 'Automatsko osvježavanje ponovno je uključeno.'); });
  $('demo-refresh').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await refresh(); feedback('Demo očitanja su osvježena. Pogledaj temperaturu, osvijetljenost i vrijeme provjere.'); } catch (error) { feedback(error.message, true); } finally { button.disabled = false; }
  });
  $('demo-reset').addEventListener('click', reset);
  $('demo-period').addEventListener('change', renderTrend); $('demo-alarm-filter').addEventListener('change', renderAlarms);
  for (const button of document.querySelectorAll('[data-lesson]')) button.addEventListener('click', () => chooseLesson(button.dataset.lesson));
  $('demo-cards').addEventListener('input', event => {
    if (event.target.matches('.dc-search')) complete('filter');
    if (event.target.matches('.dc-range,.dc-number')) complete('controls');
  });
  $('demo-cards').addEventListener('change', event => { if (event.target.matches('.dc-select')) complete('controls'); if (event.target.matches('.dc-type-filter')) complete('filter'); });
  $('demo-cards').addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.matches('.dc-room-filter,.dc-floor-filter')) complete('filter');
    if (button.matches('.dc-toggle,.dc-step-button,.dc-power-toggle')) complete('controls');
  });
  for (const button of document.querySelectorAll('[data-demo-launch]')) button.addEventListener('click', () => {
    const action = button.dataset.demoLaunch;
    $('isprobaj').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (instructions[action]) chooseLesson(action);
    if (action === 'rooms') openRooms();
    else if (action === 'settings') openSettings(cards.getDevices().find(device => device.key.endsWith('/AC309')));
    else if (action === 'trend' || action === 'alarm') $(action === 'trend' ? 'demo-period' : 'demo-alarm-filter').focus();
    else if (action === 'refresh') $('demo-refresh').focus({ preventScroll: true });
    else if (action === 'offline') $('demo-state').focus({ preventScroll: true });
    else if (action === 'filter') $('device-search').focus({ preventScroll: true });
  });
  reset(); $('demo-app').hidden = false;
  setInterval(() => { if (!paused && scenario !== 'offline' && !document.hidden && !dialog.open) void refresh().catch(() => {}); }, 10000);
})();
