const send = (msg) => chrome.runtime.sendMessage(msg);

let currentHost = null;   // normalized domain of active tab
let currentUrl = null;
let state = null;
let countdownTimer = null;
let breakTimer = null;
let selectedDuration = 25;

function fmt(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// send the active tab to a URL (used to auto-open a site after a break)
async function navigateActiveTab(url) {
  const tab = await getActiveTab();
  if (tab?.id) chrome.tabs.update(tab.id, { url });
}

// ---------- helpers ----------
function normalize(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  return s && s.includes('.') ? s : null;
}

function isBlockable(url) {
  return /^https?:\/\//.test(url || '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ask background for a gated action, prompting for a password if required.
function gatedSend(baseMsg, subText) {
  return new Promise((resolve) => {
    send(baseMsg).then((res) => {
      if (res?.ok) return resolve(res);
      if (res?.needsPassword) {
        openPwdModal(subText, async (pwd) => {
          const res2 = await send({ ...baseMsg, password: pwd });
          if (res2?.ok) { closePwdModal(); resolve(res2); }
          else showPwdError(res2?.error || 'Incorrect password');
        });
      } else {
        resolve(res);
      }
    });
  });
}

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-block').classList.toggle('hidden', tab !== 'block');
    document.getElementById('tab-focus').classList.toggle('hidden', tab !== 'focus');
    document.getElementById('tab-stats').classList.toggle('hidden', tab !== 'stats');
    if (tab === 'stats') loadStats();
  });
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('changeSites').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---------- render block tab ----------
function renderBlockTab() {
  const hostEl = document.getElementById('siteHost');
  const statusEl = document.getElementById('siteStatus');
  const toggleBtn = document.getElementById('toggleBlock');
  const tempOptions = document.getElementById('tempOptions');
  const tempInfo = document.getElementById('tempInfo');
  const favicon = document.getElementById('siteFavicon');
  const blockNowBtn = document.getElementById('blockNow');

  if (breakTimer) { clearInterval(breakTimer); breakTimer = null; }

  if (!currentHost) {
    hostEl.textContent = 'No site';
    statusEl.textContent = 'This tab can’t be blocked.';
    statusEl.className = 'site-status';
    toggleBtn.classList.add('hidden');
    tempOptions.classList.add('hidden');
    tempInfo.classList.add('hidden');
    blockNowBtn.classList.add('hidden');
    return;
  }

  hostEl.textContent = currentHost;
  favicon.style.backgroundImage =
    `url(https://www.google.com/s2/favicons?domain=${currentHost}&sz=64)`;

  const secondaryBtn = document.getElementById('secondaryAction');
  const mode = state.blockedSites.includes(currentHost) ? 'always'
    : state.focusSites.includes(currentHost) ? 'focus' : null;
  const tempUntil = state.tempUnblocks?.[currentHost];
  const focusActive = state.focus.active && state.focus.endsAt > Date.now();
  const onBreak = mode === 'always' && !focusActive && tempUntil && tempUntil > Date.now();

  toggleBtn.classList.remove('hidden');
  secondaryBtn.classList.remove('hidden');
  tempInfo.classList.add('hidden');
  tempOptions.classList.add('hidden');
  blockNowBtn.classList.add('hidden');

  if (mode === 'always') {
    if (onBreak) {
      statusEl.textContent = 'On a temporary break';
      statusEl.className = 'site-status allowed';
      const tick = () => {
        const left = tempUntil - Date.now();
        if (left <= 0) { clearInterval(breakTimer); breakTimer = null; refresh(); return; }
        tempInfo.textContent = `⏱ Re-blocks in ${fmt(left)}`;
      };
      tick();
      breakTimer = setInterval(tick, 1000);
      tempInfo.classList.remove('hidden');
      blockNowBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = 'Blocked always';
      statusEl.className = 'site-status blocked';
      tempOptions.classList.toggle('hidden', focusActive);
    }
    secondaryBtn.textContent = 'Switch to Focus-only';
    secondaryBtn.dataset.action = 'blockFocus';
    toggleBtn.textContent = 'Unblock permanently';
    toggleBtn.className = 'btn btn-primary danger';
    toggleBtn.dataset.action = 'unblock';
  } else if (mode === 'focus') {
    if (focusActive) {
      statusEl.textContent = 'Blocked during Focus';
      statusEl.className = 'site-status blocked';
    } else {
      statusEl.textContent = 'Allowed now · blocks in Focus';
      statusEl.className = 'site-status';
    }
    secondaryBtn.textContent = 'Block always instead';
    secondaryBtn.dataset.action = 'blockAlways';
    toggleBtn.textContent = 'Unblock';
    toggleBtn.className = 'btn btn-primary danger';
    toggleBtn.dataset.action = 'unblock';
  } else {
    statusEl.textContent = 'Not blocked';
    statusEl.className = 'site-status allowed';
    secondaryBtn.textContent = 'Block during Focus only';
    secondaryBtn.dataset.action = 'blockFocus';
    toggleBtn.textContent = 'Block this site';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.dataset.action = 'blockAlways';
  }
}

// Perform a block-tab action, then refresh + reload the tab so it takes effect.
async function performAction(action) {
  if (!currentHost) return;
  if (action === 'blockAlways') {
    await send({ type: 'blockSite', domain: currentHost, mode: 'always' });
  } else if (action === 'blockFocus') {
    await send({ type: 'blockSite', domain: currentHost, mode: 'focus' });
  } else if (action === 'unblock') {
    const res = await gatedSend(
      { type: 'unblockSite', domain: currentHost },
      `Enter your password to unblock ${currentHost}.`
    );
    if (!res?.ok) return; // cancelled or failed
  }
  await refresh();
  const tab = await getActiveTab();
  if (tab?.id) chrome.tabs.reload(tab.id);
}

document.getElementById('toggleBlock').addEventListener('click', () =>
  performAction(document.getElementById('toggleBlock').dataset.action));
document.getElementById('secondaryAction').addEventListener('click', () =>
  performAction(document.getElementById('secondaryAction').dataset.action));

document.getElementById('blockNow').addEventListener('click', async () => {
  if (!currentHost) return;
  await send({ type: 'reblockNow', domain: currentHost });
  await refresh();
  navigateActiveTab(`https://${currentHost}`); // redirect back → shows the block page
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const minutes = Number(chip.dataset.min);
    const res = await send({ type: 'tempUnblock', domain: currentHost, minutes });
    if (res?.ok) {
      // auto-redirect straight to the site now that it's unblocked
      navigateActiveTab(`https://${currentHost}`);
      window.close();
    } else if (res?.error) {
      alert(res.error);
    }
  });
});

// ---------- focus tab ----------
document.querySelectorAll('.dur').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dur').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedDuration = Number(btn.dataset.min);
  });
});

document.getElementById('startFocus').addEventListener('click', async () => {
  await send({ type: 'startFocus', minutes: selectedDuration });
  await refresh();
});

document.getElementById('stopFocus').addEventListener('click', async () => {
  const res = await gatedSend(
    { type: 'stopFocus' },
    'Enter your password to end the focus session early.'
  );
  if (res?.ok || !res?.needsPassword) await refresh();
});

function renderFocusTab() {
  const focusActive = state.focus.active && state.focus.endsAt > Date.now();
  document.getElementById('focusIdle').classList.toggle('hidden', focusActive);
  document.getElementById('focusActive').classList.toggle('hidden', !focusActive);

  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (focusActive) {
    const tick = () => {
      const left = Math.max(0, state.focus.endsAt - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      document.getElementById('countdown').textContent =
        `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (left <= 0) { clearInterval(countdownTimer); refresh(); }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }
}

// ---------- stats tab ----------
function fmtDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return s <= 0 ? '0m' : '<1m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  return DAY_LABELS[new Date(y, m - 1, d).getDay()];
}

async function loadStats() {
  const trackingOn = state?.settings?.trackUsage !== false;
  document.getElementById('statsDisabled').classList.toggle('hidden', trackingOn);

  const res = await send({ type: 'getStats' });
  if (!res?.ok) return;
  const { today, todayTotal, weekTotal, days } = res.stats;

  document.getElementById('todayTotal').textContent = fmtDuration(todayTotal);
  document.getElementById('weekTotal').textContent = fmtDuration(weekTotal);

  // 7-day bar chart
  const chart = document.getElementById('weekChart');
  chart.innerHTML = '';
  const max = Math.max(1, ...days.map((d) => d.total));
  days.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const barWrap = document.createElement('div');
    barWrap.className = 'bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.max(3, (d.total / max) * 100)}%`;
    if (i === days.length - 1) bar.classList.add('bar-today');
    bar.title = fmtDuration(d.total);
    barWrap.appendChild(bar);
    const lbl = document.createElement('div');
    lbl.className = 'bar-label';
    lbl.textContent = dayLabel(d.key);
    col.append(barWrap, lbl);
    chart.appendChild(col);
  });

  // today's top sites
  const list = document.getElementById('topSites');
  list.innerHTML = '';
  const top = today.slice(0, 8);
  document.getElementById('statsEmpty').classList.toggle('hidden', top.length > 0 || !trackingOn);
  const maxSite = Math.max(1, ...top.map((s) => s.seconds));
  for (const s of top) {
    const li = document.createElement('li');
    const icon = document.createElement('img');
    icon.className = 'site-ico';
    icon.src = `https://www.google.com/s2/favicons?domain=${s.domain}&sz=64`;
    const body = document.createElement('div');
    body.className = 'site-body';
    const row = document.createElement('div');
    row.className = 'site-row';
    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = s.domain;
    const time = document.createElement('span');
    time.className = 'site-time';
    time.textContent = fmtDuration(s.seconds);
    row.append(name, time);
    const track = document.createElement('div');
    track.className = 'site-track';
    const fill = document.createElement('div');
    fill.className = 'site-fill';
    fill.style.width = `${(s.seconds / maxSite) * 100}%`;
    track.appendChild(fill);
    body.append(row, track);
    li.append(icon, body);
    list.appendChild(li);
  }
}

// ---------- password modal ----------
let pwdCallback = null;
function openPwdModal(subText, cb) {
  pwdCallback = cb;
  document.getElementById('pwdModalSub').textContent = subText || 'Enter your password to continue.';
  document.getElementById('pwdInput').value = '';
  document.getElementById('pwdError').classList.add('hidden');
  document.getElementById('pwdModal').classList.remove('hidden');
  document.getElementById('pwdInput').focus();
}
function closePwdModal() {
  document.getElementById('pwdModal').classList.add('hidden');
  pwdCallback = null;
}
function showPwdError(msg) {
  const el = document.getElementById('pwdError');
  el.textContent = msg;
  el.classList.remove('hidden');
}
document.getElementById('pwdCancel').addEventListener('click', closePwdModal);
document.getElementById('pwdConfirm').addEventListener('click', () => {
  if (pwdCallback) pwdCallback(document.getElementById('pwdInput').value);
});
document.getElementById('pwdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && pwdCallback) pwdCallback(document.getElementById('pwdInput').value);
});

// ---------- boot ----------
async function refresh() {
  const res = await send({ type: 'getState' });
  state = res.state;
  renderBlockTab();
  renderFocusTab();
}

async function init() {
  const tab = await getActiveTab();
  currentUrl = tab?.url || '';
  currentHost = isBlockable(currentUrl) ? normalize(currentUrl) : null;
  await refresh();
}

init();
