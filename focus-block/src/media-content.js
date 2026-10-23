// Runs in each HTTP(S) frame. No site allowlist, page text, media URLs or titles
// are collected. Muted video, background audio and PiP all use the same clock.
(() => {
  if (globalThis.__focusBlockMedia) return;
  globalThis.__focusBlockMedia = true;
  const players = new Map();
  const roots = new WeakSet();
  let pending = [], lastSend = 0, dead = false;
  function send(force = false) {
    if (dead || !pending.length || (!force && Date.now() - lastSend < 5000)) return;
    const intervals = pending; pending = []; lastSend = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'mediaProgress', intervals }).catch(() => { dead = true; });
    } catch { dead = true; }
  }
  function sample(player, reset = false) {
    if (dead) return;
    const t = Date.now(), previous = players.get(player);
    const position = player.currentTime;
    if (previous && previous.playing && !reset) {
      const wall = t - previous.at;
      const moved = (position - previous.position) / previous.rate * 1000;
      // Progress is evidence of playback, not merely a play() request. Limit to
      // wall time so 2x speed and seeks cannot inflate time spent watching.
      if (wall > 0 && wall <= 130000 && moved > 0 && moved <= wall + 1500) {
        pending.push([t - Math.min(wall, moved), t]);
      }
    }
    players.set(player, {
      at: t, position, rate: player.playbackRate || 1,
      playing: !player.paused && !player.ended && !player.seeking && player.readyState >= 2,
    });
  }
  function watch(player) {
    if (dead || players.has(player)) return;
    sample(player, true);
    for (const event of ['playing', 'timeupdate', 'pause', 'ended', 'waiting', 'emptied', 'seeking', 'seeked', 'ratechange']) {
      player.addEventListener(event, () => {
        if (dead) return;
        sample(player, event === 'seeking' || event === 'seeked' || event === 'emptied');
        if (event === 'waiting') players.get(player).playing = false;
        send(event !== 'timeupdate');
      });
    }
  }
  function scan(root) {
    if (dead) return;
    if (root instanceof HTMLMediaElement) watch(root);
    if (root.shadowRoot) observe(root.shadowRoot);
    for (const node of root.querySelectorAll?.('*') || []) {
      if (node instanceof HTMLMediaElement) watch(node);
      if (node.shadowRoot) observe(node.shadowRoot);
    }
  }
  function observe(root) {
    if (roots.has(root)) return;
    roots.add(root); scan(root);
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }).observe(root, { childList: true, subtree: true });
  }
  observe(document);
  // timeupdate handles normal/background media; this also finds shadow roots
  // attached after their host and flushes sparse events without requiring focus.
  const timer = setInterval(() => {
    if (dead) { clearInterval(timer); return; }
    scan(document);
    for (const player of players.keys()) {
      if (!player.isConnected) { sample(player); players.delete(player); }
      else sample(player);
    }
    send();
  }, 5000);
  addEventListener('pagehide', () => {
    for (const player of players.keys()) sample(player);
    send(true);
    players.clear();
  });
})();
