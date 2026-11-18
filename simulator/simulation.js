const heights = [0, 2, 4, 6, 8];
const criticalHeight = 8;
const stageNames = { normal: '정상', interest: '관심', warning: '경고', emergency: '긴급', offline: '통신 단절' };

function initialState() {
  const reading = { at: 14 * 3600 + 28 * 60 + 37, level: -1, rate: null, rapid: false };
  return { local: reading, received: reading, online: true, rain: 0, history: [] };
}

function risk(reading, rain) {
  const { level, rate, rapid } = reading;
  const eta = level >= criticalHeight ? 0 : rate > 0 ? (criticalHeight - level) / rate : null;
  if (level >= criticalHeight) return { stage: 'emergency', eta, reason: '위험 수위 8cm에 도달했습니다.' };
  if (rapid) return { stage: 'emergency', eta, reason: '여러 수위 센서가 동시에 감지됐습니다.' };
  if (eta !== null && eta <= 5) return { stage: 'emergency', eta, reason: '위험 수위 도달 예상 시간이 5분 이내입니다.' };
  if (eta !== null && eta <= 15) return { stage: 'warning', eta, reason: '위험 수위 도달 예상 시간이 15분 이내입니다.' };
  if (level >= 0) return { stage: 'interest', eta, reason: '실내 물 유입 감지 · 수위 변화를 확인하세요.' };
  if (rain >= 30) return { stage: 'interest', eta, reason: '가상 강수량이 시연 기준인 30mm에 도달했습니다.' };
  return { stage: 'normal', eta, reason: '실내 물 유입이 감지되지 않았습니다.' };
}

function record(state, message) {
  state.history.unshift({ at: state.local.at, message });
  state.history.length = Math.min(state.history.length, 100);
}

function sample(state, level, seconds, rain) {
  const previous = state.local;
  const oldStage = risk(state.received, state.rain).stage;
  const oldLocalStage = risk(previous, 0).stage;
  const crossed = heights.filter(height => previous.level < height && height <= level);
  const rapid = crossed.length > 1 || (previous.rapid && previous.level === level);
  const rate = crossed.length === 1 && previous.level >= 0
    ? (level - previous.level) / (seconds / 60)
    : null;
  state.local = { at: previous.at + seconds, level, rate, rapid };
  state.rain = rain;
  if (state.online) state.received = state.local;
  if (crossed.length) record(state, '현장 감지 · ' + crossed.map(height => height + 'cm').join(', '));
  if (level < previous.level) record(state, level < 0 ? '현장 센서 건조 · 복구' : '감지 해제 · 배수 또는 신호 변동');
  const localStage = risk(state.local, 0).stage;
  if (localStage !== oldLocalStage && [localStage, oldLocalStage].some(stage => ['warning', 'emergency'].includes(stage))) {
    record(state, '현장 경보 · ' + stageNames[localStage]);
  }
  const newStage = risk(state.received, rain).stage;
  if (state.online && oldStage !== newStage) record(state, '서버 경보 · ' + stageNames[newStage]);
}

function setConnection(state, online) {
  state.online = online;
  if (online) state.received = state.local;
  record(state, online ? '센서 통신 복구 · 최신 상태 수신' : '센서 통신 단절 · 현장 감지는 계속 동작');
}

const scenario = [
  { title: '1 / 5 · 정상 및 강수 증가', samples: [[-1, 1, 0], [-1, 1, 48]] },
  { title: '2 / 5 · 0cm 바닥 유입 감지', samples: [[0, 1, 48]] },
  { title: '3 / 5 · 2cm 감지, ETA 약 10분', samples: [[2, 200, 48]] },
  { title: '4 / 5 · 4cm·6cm 동시 감지, 긴급', samples: [[6, 30, 48]] },
  { title: '5 / 5 · 통신 단절 중 8cm 도달', offline: true, samples: [[8, 30, 48]] },
];

function mount() {
  let state = initialState();
  let step = 0;
  const byId = id => document.getElementById(id);
  const show = (id, value) => {
    const element = byId(id);
    if (element.textContent !== value) element.textContent = value;
  };
  const clock = seconds => [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
  const form = byId('controls');
  const input = name => form.elements.namedItem(name);

  function render() {
    const localRisk = risk(state.local, 0);
    const serverRisk = risk(state.received, state.rain);
    const { at, level, rate } = state.received;
    const alertStage = state.online ? serverRisk.stage : 'offline';
    byId('alert').dataset.stage = alertStage;
    show('stage', stageNames[alertStage]);
    show('reason', state.online ? serverRisk.reason : '서버 수위는 마지막 수신값입니다. ETA 신뢰도가 낮아 표시를 중지했습니다.');
    show('link', state.online ? '연결됨' : '연결 끊김');
    show('last', '최종 수신 ' + clock(at));
    show('clock', clock(state.local.at));
    show('level', level < 0 ? '건조' : level + ' cm');
    show('rate', state.online && rate !== null ? rate.toFixed(2) + ' cm/분' : '—');
    const eta = state.online ? serverRisk.eta : null;
    show('eta', eta === null ? '—' : eta === 0 ? '수위 도달' : '약 ' + Number(eta.toFixed(1)) + '분');
    show('rain', state.rain + ' mm');
    const isAlarm = ['warning', 'emergency'].includes(localRisk.stage);
    byId('buzzer').classList.toggle('active', isAlarm);
    show('buzzer', '현장 표시등 ' + stageNames[localRisk.stage] + ' · 부저 ' + (isAlarm ? '켜짐' : '꺼짐'));
    show('toggle', state.online ? '센서 통신 끊기' : '센서 통신 복구');
    byId('next').disabled = step >= scenario.length;
    input('level').value = String(state.local.level);
    input('rain').value = String(state.rain);

    byId('sensors').replaceChildren(...heights.map(height => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const status = document.createElement('strong');
      const wet = height <= state.local.level;
      label.textContent = height === 0 ? '0cm · 바닥' : height + 'cm';
      status.textContent = wet ? '감지' : '건조';
      status.classList.toggle('wet', wet);
      row.append(label, status);
      return row;
    }));
    byId('history').replaceChildren(...state.history.map(event => {
      const row = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = clock(event.at);
      row.append(time, event.message);
      return row;
    }));
  }

  byId('next').addEventListener('click', () => {
    if (step === 0) state = initialState();
    const current = scenario[step++];
    if (current.offline) setConnection(state, false);
    else if (!state.online) setConnection(state, true);
    for (const inputs of current.samples) sample(state, ...inputs);
    show('scenario', current.title);
    render();
  });
  byId('reset').addEventListener('click', () => {
    state = initialState();
    step = 0;
    form.reset();
    show('scenario', '다음 단계 버튼으로 시연을 시작하세요.');
    render();
  });
  byId('toggle').addEventListener('click', () => {
    setConnection(state, !state.online);
    render();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    sample(state, Number(input('level').value), Number(input('elapsed').value), Number(input('rain').value));
    step = 0;
    show('scenario', '수동 조작 중 · 다음 단계 버튼을 누르면 시나리오를 처음부터 시작합니다.');
    render();
  });
  render();
}

if (typeof document !== 'undefined') mount();
if (typeof module !== 'undefined') module.exports = { initialState, risk, sample, scenario, setConnection };
