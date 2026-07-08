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

async function boot() {
  const res = await chrome.runtime.sendMessage({ type: 'getState' });
  const state = res.state;
  const focusActive = state.focus.active && state.focus.endsAt > Date.now();
  const isFocusOnly = (state.focusSites || []).includes(site);
  // Focus-only sites are blocked *because* a session is running → no breaks.
  // Always-blocked sites allow timed breaks, unless a focus session is on.
  const subEl = document.querySelector('.sub');
  if (isFocusOnly) subEl.textContent = 'This site is blocked during your focus session.';
  document.getElementById('breakArea').classList.toggle('hidden', focusActive || isFocusOnly);
  document.getElementById('focusNote').classList.toggle('hidden', !focusActive);
  if (state.settings?.cleanBlockPage) {
    document.getElementById('quote').classList.add('hidden');
  }
}

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

boot();
