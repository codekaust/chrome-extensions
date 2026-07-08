const QUOTES = [
  'The successful warrior is the average person, with laser-like focus.',
  'You will never reach your destination if you stop to throw stones at every dog that barks.',
  'Where focus goes, energy flows.',
  'It’s not that I’m so smart, it’s just that I stay with problems longer.',
  'Discipline is choosing between what you want now and what you want most.',
  'The main thing is to keep the main thing the main thing.',
  'Concentrate all your thoughts upon the work at hand.',
];

const params = new URLSearchParams(location.search);
const site = params.get('site') || '';
document.getElementById('site').textContent = site || 'this site';

// pick a quote deterministically from the site name (no Math.random needed)
let seed = 0;
for (const c of site) seed = (seed + c.charCodeAt(0)) % QUOTES.length;
document.getElementById('quote').textContent = `“${QUOTES[seed]}”`;

let hasPassword = false;

async function boot() {
  const res = await chrome.runtime.sendMessage({ type: 'getState' });
  const state = res.state;
  const focusActive = state.focus.active && state.focus.endsAt > Date.now();
  const isFocusOnly = (state.focusSites || []).includes(site);
  hasPassword = !!state.password;
  // Focus-only sites are blocked *because* a session is running → no breaks.
  // Always-blocked sites allow timed breaks, unless a focus session is on.
  const subEl = document.querySelector('.sub');
  if (isFocusOnly) subEl.textContent = 'This site is blocked during your focus session.';
  // Break + list-management are offered only for always-blocked sites while no
  // focus session runs — during focus everything stays locked.
  const unlocked = !focusActive && !isFocusOnly;
  document.getElementById('breakArea').classList.toggle('hidden', !unlocked);
  document.getElementById('manageArea').classList.toggle('hidden', !unlocked);
  document.getElementById('focusNote').classList.toggle('hidden', !focusActive);
  // A password gates any change to how the site is blocked (same as the popup).
  document.getElementById('pwdRow').classList.toggle('hidden', !hasPassword);
  document.getElementById('focusOnlyBtn').classList.toggle('hidden', isFocusOnly);
  if (state.settings?.cleanBlockPage) {
    document.getElementById('quote').classList.add('hidden');
  }
  // A focus-only site frees up the instant the session ends — schedule the
  // redirect for that moment so it doesn't wait on the next storage change.
  if (isFocusOnly && focusActive) {
    const msLeft = state.focus.endsAt - Date.now();
    setTimeout(maybeRedirect, Math.max(0, msLeft) + 300);
  }
}

// Is this site still blocked right now, given focus + temp breaks? Mirrors the
// service worker's computeEffectiveBlocked for the single site we're showing.
function stillBlocked(state) {
  const t = Date.now();
  const focusActive = state.focus.active && state.focus.endsAt > t;
  if ((state.blockedSites || []).includes(site)) {
    if (focusActive) return true;                 // always-blocked, breaks ignored in focus
    const until = state.tempUnblocks?.[site];
    return !(until && until > t);                 // allowed only during an active break
  }
  if ((state.focusSites || []).includes(site)) return focusActive;
  return false;
}

// When the site stops being blocked (focus ends, unblocked elsewhere, or a
// break starts), send the user back to where they were trying to go.
async function maybeRedirect() {
  if (!site) return;
  const res = await chrome.runtime.sendMessage({ type: 'getState' });
  if (res?.state && !stillBlocked(res.state)) {
    location.href = `https://${site}`;
  }
}

// React to focus ending / list changes live, without needing a manual refresh.
chrome.storage.onChanged.addListener(() => { maybeRedirect(); });

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const minutes = Number(chip.dataset.min);
    const res = await chrome.runtime.sendMessage({ type: 'tempUnblock', domain: site, minutes });
    if (res?.ok) {
      // brief delay so the rule update lands before we navigate
      setTimeout(() => { location.href = `https://${site}`; }, 250);
    } else {
      const err = document.getElementById('breakError');
      err.textContent = res?.error || 'Could not start a break.';
      err.classList.remove('hidden');
    }
  });
});

function showManageError(msg) {
  const err = document.getElementById('manageError');
  err.textContent = msg;
  err.classList.remove('hidden');
  if (hasPassword) document.getElementById('pwd').focus();
}

// Unblock this site entirely, then continue to it.
document.getElementById('unblockBtn').addEventListener('click', async () => {
  const password = hasPassword ? document.getElementById('pwd').value : undefined;
  const res = await chrome.runtime.sendMessage({ type: 'unblockSite', domain: site, password });
  if (res?.ok) {
    setTimeout(() => { location.href = `https://${site}`; }, 250);
  } else {
    showManageError(res?.error || 'Could not unblock this site.');
  }
});

// Move this site to the focus-only list, then continue (it's now allowed
// outside of focus sessions). Gated by the same password as unblocking.
document.getElementById('focusOnlyBtn').addEventListener('click', async () => {
  const password = hasPassword ? document.getElementById('pwd').value : undefined;
  const res = await chrome.runtime.sendMessage({ type: 'blockSite', domain: site, mode: 'focus', password });
  if (res?.ok) {
    setTimeout(() => { location.href = `https://${site}`; }, 250);
  } else {
    showManageError(res?.error || 'Could not update this site.');
  }
});

boot();
