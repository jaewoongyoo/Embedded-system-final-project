const base = '/api/stores/store01';
const names = { normal: '정상', interest: '관심', warning: '경고', emergency: '긴급' };
const titles = { normal: '실내 침수 징후 없음', interest: '현장 상태 확인 필요', warning: '현재 실내 침수 감지 중', emergency: '즉시 현장 상황 확인 필요' };
const byId = id => document.getElementById(id);
const show = (id, text) => {
  if (byId(id).textContent !== text) byId(id).textContent = text;
};
const time = at => at ? new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
const shortTime = at => new Date(at).toLocaleTimeString('ko-KR', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
});
const height = row => row.floor_wet ? (row.level_cm ?? 0) + ' cm' : '건조';
const form = byId('settings');
let settingsLoaded = false;

function metric(id, value, unit = '') {
  show(id, value);
  show(id + '-unit', unit);
}

function connection(id, label, connected) {
  show(id, label);
  byId(id).dataset.connected = connected;
}

function notice(row) {
  const eta = row.eta_min > 0 ? ' · 위험 수위까지 약 ' + Number(row.eta_min.toFixed(1)) + '분' : '';
  return shortTime(row.at) + ' · ' + names[row.level] + ' · ' + row.message + eta;
}

async function request(path, options) {
  const response = await fetch(base + path, options);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function list(id, entries) {
  byId(id).replaceChildren(...entries.map(text => {
    const row = document.createElement('li');
    row.textContent = text;
    return row;
  }));
}

function drawHistory(history) {
  const canvas = byId('chart');
  const ctx = canvas.getContext('2d');
  const rows = history.slice().reverse();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '13px sans-serif';
  const y = level => 147 - (level + 1) * 14;
  for (const level of [-1, 0, 2, 4, 6, 8]) {
    ctx.fillStyle = '#5c758b';
    ctx.fillText(level < 0 ? '건조' : level + 'cm', 4, y(level) + 3);
    ctx.strokeStyle = '#d9e6ef';
    ctx.beginPath();
    ctx.moveTo(42, y(level));
    ctx.lineTo(685, y(level));
    ctx.stroke();
  }
  if (!rows.length) {
    ctx.fillText('수위 데이터 수신 대기', 58, 38);
    return;
  }
  const first = Date.parse(rows[0].at);
  const last = Date.parse(rows.at(-1).at);
  const x = at => 43 + 642 * (Date.parse(at) - first) / Math.max(1, last - first);
  ctx.strokeStyle = ctx.fillStyle = '#008997';
  ctx.lineWidth = 3;
  ctx.beginPath();
  let previousY;
  for (const row of rows) {
    const point = x(row.at);
    const currentY = y(row.floor_wet ? row.level_cm ?? 0 : -1);
    if (previousY === undefined) ctx.moveTo(point, currentY);
    else ctx.lineTo(point, previousY);
    ctx.lineTo(point, currentY);
    ctx.fillRect(point - 2, currentY - 2, 4, 4);
    previousY = currentY;
  }
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = '#5c758b';
  ctx.textAlign = 'center';
  const labels = Math.min(5, rows.length);
  for (let index = 0; index < labels; index++) {
    const at = first + (last - first) * index / Math.max(1, labels - 1);
    ctx.fillText(shortTime(at), x(at), 169);
  }
  ctx.textAlign = 'start';
}

async function refresh() {
  try {
    const [status, history, weather, alerts] = await Promise.all(
      ['/status', '/history', '/weather', '/alerts'].map(path => request(path))
    );
    const stale = status.connection === 'stale';
    byId('alert').dataset.stage = stale ? 'offline' : status.level || 'normal';
    show('stage', stale ? '통신 지연' : names[status.level] || '수신 대기');
    show('alert-title', stale ? '센서 응답 확인 필요' : titles[status.level] || '센서 데이터 수신 대기');
    show('reason', stale ? '마지막 수신 수위를 표시합니다. ETA는 수신 재개 후 갱신됩니다.' : status.message || '');
    connection('connection', status.broker_connected ? 'MQTT · 연결됨' : 'MQTT · 연결 끊김', status.broker_connected);
    connection('sensor-connection', stale ? '센서 · 통신 지연' : status.at ? '센서 · 연결됨' : '센서 · 수신 대기', status.connection === 'online');
    show('last', status.received_at ? '· 최종 수신 ' + time(status.received_at) : '');
    show('quality', status.quality === 'simulated' ? 'DEMO · 가상 센서' : status.at ? '현장 센서' : '장치 대기');
    const detected = status.floor_wet ? status.level_cm ?? 0 : null;
    metric('level', detected === null ? (status.at ? '건조' : '—') : detected.toFixed(1), detected === null ? '' : 'cm');
    metric('rate', status.rate_cm_min == null ? '—' : status.rate_cm_min.toFixed(2), status.rate_cm_min == null ? '' : 'cm/분');
    const remaining = detected === null ? null : Math.max(0, status.settings.critical_cm - detected);
    metric('remaining', remaining === null ? '—' : remaining.toFixed(1), remaining === null ? '' : 'cm');
    metric('eta', status.eta_min == null ? '—' : status.eta_min === 0 ? '도달' : '약 ' + Number(status.eta_min.toFixed(1)), status.eta_min > 0 ? '분' : '');
    metric('rain', weather.rn1_mm == null ? '—' : String(weather.rn1_mm), weather.rn1_mm == null ? '' : 'mm');
    show('weather-source', weather.source === 'simulated' ? '가상 강수 데이터' : '기상청 강수 데이터');
    show('weather-time', (weather.status === 'error' ? '조회 실패 · 마지막 관측 ' : '관측 시각 ') + time(weather.at));
    list('forecast', weather.forecast.map(row => row.date + ' ' + row.time + ' · ' + row.rain));
    if (!weather.forecast.length) list('forecast', ['표시할 예보가 없습니다.']);
    list('history', history.map(row => time(row.at) + ' · ' + height(row)));
    list('alerts', alerts.map(notice));
    show('latest-alert', alerts.length ? notice(alerts[0]) : '수신된 경보가 없습니다.');
    drawHistory(history);
    show('store', status.settings.name);
    show('critical-summary', '위험 수위 ' + status.settings.critical_cm + ' cm');
    show('warning-summary', '경보 기준 · ETA ' + status.settings.warning_min + '분 이하');
    if (!settingsLoaded) {
      for (const [key, value] of Object.entries(status.settings)) form.elements.namedItem(key).value = value;
      form.querySelector('button').disabled = false;
      settingsLoaded = true;
    }
  } catch {
    byId('alert').dataset.stage = 'offline';
    show('stage', '서버 연결 실패');
    show('alert-title', '대시보드 연결 확인 필요');
    show('reason', '서버 응답을 기다리는 중입니다.');
    connection('connection', '서버 · 연결 끊김', false);
    connection('sensor-connection', '센서 · 확인 불가', false);
    metric('rate', '—');
    metric('eta', '—');
  } finally {
    setTimeout(refresh, 1500);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const values = new FormData(form);
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: values.get('name'), critical_cm: Number(values.get('critical_cm')),
        warning_min: Number(values.get('warning_min')),
      }),
    });
    show('save-result', '저장했습니다.');
  } catch {
    show('save-result', '저장하지 못했습니다.');
  } finally {
    button.disabled = false;
  }
});

function navigate() {
  const target = location.hash || '#overview';
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === target) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  if (target === '#store-settings' || target === '#alert-history') {
    document.querySelector(target + ' details').open = true;
  }
}

window.addEventListener('hashchange', navigate);
navigate();

refresh();
