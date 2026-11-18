// The helper's one job: while a board's login window is open, a top-level navigation of that window to the reviewed
// site's real origin goes to the site's view host instead, so an identity provider's redirect back with the code
// reaches the board's proxy and the site's server finishes the login there, where its state cookie is. Only the tab
// the board opened gets a rule, only for that one site, and only until the window closes, the board says it is done
// or LIFETIME passes. Nothing is logged, kept or sent anywhere: the addresses carry login codes.
import { LIFETIME, checkLogin, ruleFor } from "./rules.js"

// The board opens its window in the click and names the site once it has the view ticket, a moment later, so a tab
// it opened waits this long for that word, and a word this long for its tab.
const MATCH = 15 * 1000
// Tabs a board's page opened, by tab: { board, at }. Kept in memory, the two halves come within seconds.
const opened = new Map()
// What a board asked for before its tab showed up, by board tab: { site, view, at }.
const asked = new Map()

const alarmOf = (tab, board) => `login:${tab}:${board}`
const parseAlarm = (name) => {
  const m = /^login:(\d+):(\d+)$/.exec(name)
  return m ? { tab: Number(m[1]), board: Number(m[2]) } : null
}

function prune(now = Date.now()) {
  for (const [tab, o] of opened) if (now - o.at > MATCH) opened.delete(tab)
  for (const [board, a] of asked) if (now - a.at > MATCH) asked.delete(board)
}

async function watch(tab, board, { site, view }) {
  // A window closed before the board's word came needs no rule.
  try {
    await chrome.tabs.get(tab)
  } catch {
    return
  }
  await clearAlarms((a) => a.tab === tab)
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tab], addRules: [ruleFor(tab, site, view)] })
  await chrome.alarms.create(alarmOf(tab, board), { when: Date.now() + LIFETIME })
}

async function clearAlarms(which) {
  for (const alarm of await chrome.alarms.getAll()) {
    const a = parseAlarm(alarm.name)
    if (a && which(a)) await chrome.alarms.clear(alarm.name)
  }
}

async function end(tab) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tab] })
  await clearAlarms((a) => a.tab === tab)
}

// Only windows the board's own page opens count, never ones a reviewed page in a device frame opens.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, sourceFrameId, tabId }) => {
  if (sourceFrameId !== 0) return
  prune()
  const word = asked.get(sourceTabId)
  if (word) {
    asked.delete(sourceTabId)
    void watch(tabId, sourceTabId, word)
    return
  }
  opened.set(tabId, { board: sourceTabId, at: Date.now() })
})

async function opening(board, pageUrl, message) {
  const login = await checkLogin(pageUrl, message.site, message.view)
  if (!login) return
  prune()
  // The newest tab this board opened, which is the window it opened last.
  const [tab] = [...opened].filter(([, o]) => o.board === board).sort((a, b) => b[1].at - a[1].at)[0] ?? []
  if (tab === undefined) {
    asked.set(board, { ...login, at: Date.now() })
    return
  }
  opened.delete(tab)
  await watch(tab, board, login)
}

async function done(board) {
  asked.delete(board)
  for (const alarm of await chrome.alarms.getAll()) {
    const a = parseAlarm(alarm.name)
    if (a?.board === board) await end(a.tab)
  }
}

// Only the content script on a board's page talks to the background, from the page's top frame.
chrome.runtime.onMessage.addListener((message, sender) => {
  const board = sender.tab?.id
  if (sender.id !== chrome.runtime.id || board === undefined || sender.frameId !== 0 || !sender.url) return
  if (message?.type === "login-window") void opening(board, sender.url, message)
  if (message?.type === "login-window-closed") void done(board)
})

chrome.tabs.onRemoved.addListener((tab) => {
  opened.delete(tab)
  asked.delete(tab)
  void end(tab)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  const a = parseAlarm(alarm.name)
  if (a) void end(a.tab)
})
