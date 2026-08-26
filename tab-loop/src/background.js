// TabLoop service worker — owns all state.
//
// State shape: chrome.storage.local["tabs"] = { [tabId]: { seconds, nextAt } }
// One chrome.alarms alarm per tab with an active loop, named via alarmName().
// No "tabs" or host permissions are requested: every chrome.tabs call here
// only touches id-shaped fields (tabId existence, reload-by-id), which Chrome
// always populates regardless of permissions — url/title are never read.
import { alarmName, parseAlarmName, clampSeconds } from "./schedule.js";

async function getTabs() {
  const { tabs } = await chrome.storage.local.get(["tabs"]);
  return tabs || {};
}

async function setBadge(tabId, on) {
  await chrome.action.setBadgeText({ tabId, text: on ? "⟳" : "" });
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#22D3EE" });
}

async function startLoop(tabId, seconds) {
  const s = clampSeconds(seconds);
  const nextAt = Date.now() + s * 1000;
  const tabs = await getTabs();
  tabs[tabId] = { seconds: s, nextAt };
  await chrome.storage.local.set({ tabs });
  await chrome.alarms.create(alarmName(tabId), {
    delayInMinutes: s / 60,
    periodInMinutes: s / 60,
  });
  await setBadge(tabId, true);
  return { active: true, seconds: s, nextAt };
}

async function stopLoop(tabId) {
  await chrome.alarms.clear(alarmName(tabId));
  const tabs = await getTabs();
  delete tabs[tabId];
  await chrome.storage.local.set({ tabs });
  await setBadge(tabId, false);
  return { active: false };
}

async function getStatus(tabId) {
  const entry = (await getTabs())[tabId];
  return entry ? { active: true, seconds: entry.seconds, nextAt: entry.nextAt } : { active: false };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tabId = parseAlarmName(alarm.name);
  if (tabId == null) return;

  const tabs = await getTabs();
  const entry = tabs[tabId];
  if (!entry) {
    await chrome.alarms.clear(alarm.name);
    return;
  }

  try {
    await chrome.tabs.get(tabId);
  } catch {
    await stopLoop(tabId); // tab is gone — stop rather than resurrect a stray alarm
    return;
  }

  chrome.tabs.reload(tabId);
  tabs[tabId] = { ...entry, nextAt: Date.now() + entry.seconds * 1000 };
  await chrome.storage.local.set({ tabs });
});

chrome.tabs.onRemoved.addListener((tabId) => stopLoop(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.tabId !== "number") return false;
  if (msg.type === "start") {
    startLoop(msg.tabId, msg.seconds).then(sendResponse);
    return true;
  }
  if (msg.type === "stop") {
    stopLoop(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "status") {
    getStatus(msg.tabId).then(sendResponse);
    return true;
  }
  return false;
});

// Chrome doesn't guarantee tab ids stay attached to the "same" tab across a
// browser restart, even though alarms and storage both persist. Silently
// resuming reloads against a possibly-unrelated tab would be a surprising,
// unsafe default, so a fresh browser session starts with every loop cleared
// — the user re-enables per tab if they still want it.
chrome.runtime.onStartup.addListener(async () => {
  const tabs = await getTabs();
  await Promise.all(Object.keys(tabs).map((id) => chrome.alarms.clear(alarmName(Number(id)))));
  await chrome.storage.local.set({ tabs: {} });
});
