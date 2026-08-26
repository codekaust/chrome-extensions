// Pure scheduling helpers for TabLoop — no chrome.* calls, so these are
// importable from both the service worker and the popup, and are directly
// testable. Kept free of side effects on purpose.

// A floor above 0 keeps a mistyped interval from hammering a page (or its
// server) with reloads; the ceiling just keeps the UI/storage sane.
export const MIN_SECONDS = 3;
export const MAX_SECONDS = 12 * 60 * 60; // 12h

export const PRESETS = [
  { seconds: 10, label: "10s" },
  { seconds: 30, label: "30s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
  { seconds: 600, label: "10m" },
  { seconds: 1800, label: "30m" },
  { seconds: 3600, label: "1h" },
];

const ALARM_PREFIX = "tabloop:";

export function clampSeconds(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MIN_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

export function alarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

// Returns the numeric tabId encoded in an alarm name, or null if the alarm
// isn't one of ours (e.g. belongs to another extension feature).
export function parseAlarmName(name) {
  if (typeof name !== "string" || !name.startsWith(ALARM_PREFIX)) return null;
  const id = Number(name.slice(ALARM_PREFIX.length));
  return Number.isInteger(id) ? id : null;
}

export function formatInterval(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
