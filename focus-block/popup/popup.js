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

  const isBlocked = state.blockedSites.includes(currentHost);
  const tempUntil = state.tempUnblocks?.[currentHost];
  const focusActive = state.focus.active && state.focus.endsAt > Date.now();
  const onBreak = !focusActive && tempUntil && tempUntil > Date.now();

  toggleBtn.classList.remove('hidden');

  if (isBlocked) {
    if (onBreak) {
      statusEl.textContent = 'On a temporary break';
      statusEl.className = 'site-status allowed';
      // live mm:ss countdown until re-block
      const tick = () => {
        const left = tempUntil - Date.now();
        if (left <= 0) { clearInterval(breakTimer); breakTimer = null; refresh(); return; }
        tempInfo.textContent = `⏱ Re-blocks in ${fmt(left)}`;
      };
      tick();
      breakTimer = setInterval(tick, 1000);
      tempInfo.classList.remove('hidden');
      tempOptions.classList.add('hidden');
      blockNowBtn.classList.remove('hidden');   // let the user re-block early
      toggleBtn.textContent = 'Unblock permanently';
      toggleBtn.className = 'btn btn-soft';
    } else {
      statusEl.textContent = 'Blocked';
      statusEl.className = 'site-status blocked';
      tempInfo.classList.add('hidden');
      tempOptions.classList.toggle('hidden', focusActive);
      blockNowBtn.classList.add('hidden');
      toggleBtn.textContent = 'Unblock permanently';
      toggleBtn.className = 'btn btn-primary danger';
    }
  } else {
    statusEl.textContent = 'Not blocked';
    statusEl.className = 'site-status allowed';
    tempInfo.classList.add('hidden');
    tempOptions.classList.add('hidden');
    blockNowBtn.classList.add('hidden');
    toggleBtn.textContent = 'Block this site';
    toggleBtn.className = 'btn btn-primary';
  }
}

document.getElementById('blockNow').addEventListener('click', async () => {
  if (!currentHost) return;
  await send({ type: 'reblockNow', domain: currentHost });
  await refresh();
  navigateActiveTab(`https://${currentHost}`); // redirect back → shows the block page
});

document.getElementById('toggleBlock').addEventListener('click', async () => {
  if (!currentHost) return;
  const isBlocked = state.blockedSites.includes(currentHost);
  if (isBlocked) {
    const res = await gatedSend(
      { type: 'unblockSite', domain: currentHost },
      `Enter your password to unblock ${currentHost}.`
    );
    if (!res?.ok && !res?.needsPassword) return;
  } else {
    await send({ type: 'blockSite', domain: currentHost });
  }
  await refresh();
  // reload the tab so the change takes effect immediately
  const tab = await getActiveTab();
  if (tab?.id) chrome.tabs.reload(tab.id);
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
