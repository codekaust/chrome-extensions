import { refreshStats } from './stats.js';
import { LIMIT_PRESETS, limitRemaining } from '../src/limits.js';
import { fmtDuration } from '../src/stats.js';
const send = (msg) => chrome.runtime.sendMessage(msg);
let state = null;

function normalize(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  return s && s.includes('.') ? s : null;
}

// ---------- nav ----------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    location.hash = view;
    if (view === 'stats') refreshStats();
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    document.getElementById(`view-${view}`).classList.remove('hidden');
  });
});

// ---------- password gate ----------
let gateCb = null;
function openGate(sub, cb) {
  gateCb = cb;
  document.getElementById('gateSub').textContent = sub;
  document.getElementById('gateInput').value = '';
  document.getElementById('gateError').classList.add('hidden');
  document.getElementById('gateModal').classList.remove('hidden');
  document.getElementById('gateInput').focus();
}
function closeGate() { document.getElementById('gateModal').classList.add('hidden'); gateCb = null; }
function gateError(msg) {
  const el = document.getElementById('gateError');
  el.textContent = msg; el.className = 'msg err'; el.classList.remove('hidden');
}
// Cancelling leaves storage untouched; re-render so switches snap back.
document.getElementById('gateCancel').addEventListener('click', () => { closeGate(); if (state) render(); });
document.getElementById('gateConfirm').addEventListener('click', () => gateCb?.(document.getElementById('gateInput').value));
document.getElementById('gateInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') gateCb?.(document.getElementById('gateInput').value);
});

// Run a gated action; prompt for password if the background asks.
function gatedSend(baseMsg, sub) {
  return new Promise((resolve) => {
    send(baseMsg).then((res) => {
      if (res?.ok) return resolve(res);
      if (res?.needsPassword) {
        openGate(sub, async (pwd) => {
          const res2 = await send({ ...baseMsg, password: pwd });
          if (res2?.ok) { closeGate(); resolve(res2); }
          else gateError(res2?.error || 'Incorrect password');
        });
      } else resolve(res);
    });
  });
}

// ---------- general toggles ----------
document.querySelectorAll('.toggle').forEach((t) => {
  t.addEventListener('change', async () => {
    // Turning tracking off while time limits exist is password-gated.
    const res = await gatedSend(
      { type: 'setSetting', key: t.dataset.setting, value: t.checked },
      'Enter your password to turn off usage tracking — it pauses your time limits.'
    );
    if (!res?.ok) t.checked = !t.checked; // cancelled: keep the switch truthful
    await refresh();
  });
});

// ---------- password protection ----------
document.getElementById('savePwd').addEventListener('click', async () => {
  const oldPwd = document.getElementById('oldPwd').value;
  const newPwd = document.getElementById('newPwd').value;
  const msg = document.getElementById('pwdMsg');
  const res = await send({ type: 'setPassword', password: newPwd, oldPassword: oldPwd });
  if (res?.ok) {
    msg.textContent = newPwd ? 'Password saved.' : 'Password removed.';
    msg.className = 'msg ok';
    document.getElementById('oldPwd').value = '';
    document.getElementById('newPwd').value = '';
    await refresh();
  } else {
    msg.textContent = res?.error || 'Could not save password.';
    msg.className = 'msg err';
  }
  msg.classList.remove('hidden');
});

// ---------- usage data ----------
document.getElementById('clearStats').addEventListener('click', async () => {
  const msg = document.getElementById('clearMsg');
  const res = await gatedSend(
    { type: 'clearStats' },
    'Enter your password to clear your usage history.'
  );
  if (res?.ok) {
    await refreshStats();
    msg.textContent = 'Usage history cleared.';
    msg.className = 'msg ok';
    msg.classList.remove('hidden');
  }
});

// ---------- block list ----------
document.getElementById('addSite').addEventListener('click', addSite);
document.getElementById('newSite').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSite(); });
const newLimit = document.getElementById('newLimit');
for (const min of LIMIT_PRESETS) newLimit.append(new Option(`${fmtDuration(min * 60)} a day`, min, min === 30, min === 30));
document.getElementById('newMode').addEventListener('change', (e) => {
  newLimit.classList.toggle('hidden', e.target.value !== 'limit');
});

async function addSite() {
  const input = document.getElementById('newSite');
  const mode = document.getElementById('newMode').value;
  const dom = normalize(input.value);
  if (!dom) return;
  const minutes = mode === 'limit' ? Number(newLimit.value) : undefined;
  // Re-adding an existing site under a looser mode is password-gated.
  const res = await gatedSend(
    { type: 'blockSite', domain: dom, mode, minutes },
    `Enter your password to loosen how ${dom} is blocked.`
  );
  if (res?.ok) input.value = '';
  await refresh();
}

async function removeSite(dom) {
  await gatedSend(
    { type: 'unblockSite', domain: dom },
    `Enter your password to remove ${dom} from your block list.`
  );
  await refresh();
}

async function switchMode(dom, mode, minutes) {
  // Loosening (always→focus/limit, limit→focus, a higher limit) is
  // password-gated in the background; gatedSend prompts only when needed.
  await gatedSend(
    { type: 'blockSite', domain: dom, mode, minutes },
    mode === 'limit' ? `Enter your password to raise the limit on ${dom}.`
      : `Enter your password to switch ${dom} to focus-only.`
  );
  await refresh();
}

// Render one list (mode = 'always' | 'focus') into its <ul> with switch/remove.
function renderOneList(list, ulId, emptyId, mode) {
  const ul = document.getElementById(ulId);
  ul.innerHTML = '';
  document.getElementById(emptyId).classList.toggle('hidden', list.length > 0);
  for (const dom of list) {
    const li = document.createElement('li');
    const host = document.createElement('div');
    host.className = 'host';
    const img = document.createElement('img');
    img.src = `https://www.google.com/s2/favicons?domain=${dom}&sz=64`;
    host.append(img, document.createTextNode(dom));

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const swap = document.createElement('button');
    swap.className = 'linkbtn';
    swap.textContent = mode === 'always' ? 'During Focus' : 'Always';
    swap.title = mode === 'always' ? 'Only block during focus sessions' : 'Block all the time';
    swap.addEventListener('click', () => switchMode(dom, mode === 'always' ? 'focus' : 'always'));
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => removeSite(dom));
    actions.append(swap, rm);

    li.append(host, actions);
    ul.append(li);
  }
}

// Time-limited sites: today's usage, a limit picker, and the same actions.
function renderLimitList() {
  const ul = document.getElementById('limitList');
  ul.innerHTML = '';
  const limits = Object.entries(state.timeLimits || {});
  document.getElementById('limitEmpty').classList.toggle('hidden', limits.length > 0);
  document.getElementById('limitTrackingOff').classList.toggle(
    'hidden', !limits.length || state.settings.trackUsage);
  for (const [dom, minutes] of limits) {
    const li = document.createElement('li');
    const host = document.createElement('div');
    host.className = 'host';
    const img = document.createElement('img');
    img.src = `https://www.google.com/s2/favicons?domain=${dom}&sz=64`;
    const left = limitRemaining(state, dom, Date.now());
    const used = document.createElement('span');
    used.className = 'site-time';
    used.textContent = left > 0 ? `${fmtDuration(minutes * 60 - left)} used today` : 'Limit reached today';
    host.append(img, document.createTextNode(dom), used);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const pick = document.createElement('select');
    pick.className = 'input select';
    pick.setAttribute('aria-label', `Daily limit for ${dom}`);
    const presets = [...new Set([...LIMIT_PRESETS, minutes])].sort((a, b) => a - b);
    for (const min of presets) pick.append(new Option(`${fmtDuration(min * 60)} a day`, min, false, min === minutes));
    pick.addEventListener('change', () => switchMode(dom, 'limit', Number(pick.value)));
    const swap = document.createElement('button');
    swap.className = 'linkbtn';
    swap.textContent = 'Always';
    swap.title = 'Block all the time';
    swap.addEventListener('click', () => switchMode(dom, 'always'));
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => removeSite(dom));
    actions.append(pick, swap, rm);

    li.append(host, actions);
    ul.append(li);
  }
}

function renderList() {
  renderOneList(state.blockedSites, 'alwaysList', 'alwaysEmpty', 'always');
  renderOneList(state.focusSites, 'focusList', 'focusEmpty', 'focus');
  renderLimitList();
}

// ---------- render ----------
function render() {
  document.querySelectorAll('.toggle').forEach((t) => {
    t.checked = !!state.settings[t.dataset.setting];
  });
  const has = !!state.password;
  document.getElementById('pwdStatus').textContent =
    has ? '🔒 Password protection is ON' : '🔓 No password set';
  document.getElementById('oldPwd').classList.toggle('hidden', !has);
  renderList();

  const focusActive = state.focus.active && state.focus.endsAt > Date.now();
  const fs = document.getElementById('focusState');
  if (focusActive) {
    const mins = Math.ceil((state.focus.endsAt - Date.now()) / 60000);
    fs.textContent = `🎯 A focus session is running — about ${mins} min left.`;
  } else {
    fs.textContent = 'No focus session running right now.';
  }
}

async function refresh() {
  const res = await send({ type: 'getState' });
  state = res.state;
  render();
}

refresh();

const initialView = ['general', 'block', 'focus', 'stats'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'stats';
document.querySelector(`[data-view="${initialView}"]`).click();
