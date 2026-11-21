// Logs a board's devices in. A login runs in a window on the site's real address and its cookies are copied to the
// site's view host (below). Only when a copied session does not hold, one retry runs on the view host: then a top-level
// navigation of that window to the site's real origin goes to the view host instead, so the provider's code reaches
// the board's proxy and the site's server finishes the login there, where its state cookie is. Only that window's tab
// gets a rule, only for that one site, and only until the window closes, the board says it is done or LIFETIME passes.
// Nothing is logged, kept or sent anywhere: the addresses carry login codes.
import { COOLDOWN, HOSTED, LIFETIME, boardOf, checkLogin, cookieKey, framedCookie, isBoardCookie, isBoardHost, isLocal, isStep, labelOf, landing, loginLike, loginOf, parseSetCookie, reaches, refused, ruleFor, sessionChanged, siteOf, viewsOf } from "./rules.js"

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
    if (a?.board === board && !tries.has(a.tab)) await end(a.tab)
  }
}

// Only the content script on a board's page talks to the background, from the page's top frame.
chrome.runtime.onMessage.addListener((message, sender) => {
  const board = sender.tab?.id
  if (sender.id !== chrome.runtime.id || board === undefined || sender.frameId !== 0 || !sender.url) return
  if (message?.type === "login-window") void opening(board, sender.url, message)
  if (message?.type === "login-window-closed") void done(board)
  if (message?.type === "login-start") void starting(board, message)
  if (message?.type === "login-forward" && running.get(board)?.window !== undefined) forward(running.get(board))
  // The person's click on the board's offer, for a session this browser already had.
  if (message?.type === "login-use" && running.get(board)?.offered) void finish(running.get(board), "done")
  if (message?.type === "login-reloaded") reloading.delete(board)
})

chrome.tabs.onRemoved.addListener((tab) => {
  opened.delete(tab)
  asked.delete(tab)
  reloading.delete(tab)
  // A window whose board is gone has nobody to come back to.
  const a = tries.get(tab) ?? running.get(tab)
  if (a?.tab !== undefined) void finish(a, a.tab === tab ? "closed" : "failed")
  void end(tab)
})

chrome.alarms.onAlarm.addListener((alarm) => {
  const a = parseAlarm(alarm.name)
  if (!a) return
  const attempt = tries.get(a.tab)
  if (attempt) void finish(attempt, "closed")
  void end(a.tab)
})

/*
 * The login without a click. A device of a board meets a provider's login for the open site: the helper opens the
 * site's real address at once in a window of its own, over the board, where the provider may frame nothing and every
 * kind of return works, Access, SAML and form_post included. Once a login has really passed through the provider and
 * written a cookie, those cookies are copied to the site's view host in the frames' partition and the devices load
 * again. If the copy does not hold (a session bound to an address), one retry runs through the view host instead.
 */

// What runs now, by the window's tab and by the board's tab. Lost if Chrome ends the worker, which the keepalive
// below prevents while a login runs, and then the window simply stays open for the person to close.
const tries = new Map()
const running = new Map()
// Board tabs a look at an authorize address is under way for: every device may hit it in the same moment.
const spotting = new Set()
// Boards that have a copy but have not loaded their devices again: a redirect still on its way from before the copy
// says nothing about whether the copied session holds.
const reloading = new Set()
// Any extension call keeps the worker alive, and a person typing a password takes longer than its idle limit.
const KEEPALIVE = 20 * 1000
// How long a page that came back may still change the address before its verdict is read.
const SETTLE = 700
const WAIT_ANSWER = 6000
const SIZE = { width: 520, height: 720 }

const LOCAL_PAGES = ["localhost", "127.0.0.1", "*.localhost"].flatMap((h) => [`http://${h}/*`, `https://${h}/*`])
const VIEW_PAGES = [...HOSTED.values()].map((h) => `https://*.${h}/*`)

const coolOf = async (board, site) => `cool:${board}:${(await labelOf(site)).slice(-8)}`
// Set by a copy, taken by the one retry through the view host. An alarm, as the worker may sleep in between.
const againOf = async (board, site) => `again:${board}:${(await labelOf(site)).slice(-8)}`
const tell = (tab, message) => chrome.tabs.sendMessage(tab, message, { frameId: 0 })

/** The site a board tab has open, as its own page says it: { site, views, local }, or null for any other tab. */
async function openSite(tab) {
  const top = await chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 })
  const board = boardOf(top?.url)
  if (!board) return null
  const site = siteOf(await tell(tab, { type: "open-site" }))
  if (!site || site === board) return null
  const local = isLocal(site)
  return { board, site, local, views: local ? [] : await viewsOf(board, site) }
}

/** Over the board, where the person is looking, as the board places the login window it opens itself. */
async function overBoard(board) {
  const { windowId } = await chrome.tabs.get(board)
  const w = await chrome.windows.get(windowId)
  return { left: Math.round(w.left + Math.max(0, (w.width - SIZE.width) / 2)), top: Math.round(w.top + Math.max(0, (w.height - SIZE.height) / 3)) }
}

const forward = (a) => void chrome.windows.update(a.window, { state: "normal", focused: true, ...SIZE }).catch(() => {})

/** Only a frame right under the board's page is a device. A frame inside a reviewed page never counts. */
const isDevice = (d) => d.tabId >= 0 && d.frameId > 0 && d.parentFrameId === 0

async function spotted(d, from) {
  if (!isDevice(d)) return
  const to = d.redirectUrl ?? d.url
  if (!loginLike(to) || running.has(d.tabId) || spotting.has(d.tabId)) return
  spotting.add(d.tabId)
  try {
    const open = await openSite(d.tabId)
    if (!open) return
    const homes = [open.site, ...open.views]
    const source = from ? new URL(from) : null
    const found = loginOf(to, { ...open, from: source?.origin ?? null })
    if (!found) return
    // A page that sent the frame on by a plain redirect starts the login again by being opened, with a fresh state.
    const path = source && d.method === "GET" && homes.includes(source.origin) ? source.pathname + source.search : null
    // Met again after a copy: the session did not hold in the frames.
    if (await chrome.alarms.get(await againOf(d.tabId, open.site))) {
      if (!reloading.has(d.tabId)) await tell(d.tabId, found.viewable ? { type: "login-seen", path, retry: true } : { type: "login-lost" })
      return
    }
    if (await chrome.alarms.get(await coolOf(d.tabId, open.site))) return
    await tell(d.tabId, { type: "login-seen", path })
  } catch {
  } finally {
    spotting.delete(d.tabId)
  }
}

chrome.webRequest.onBeforeRedirect.addListener((d) => void spotted(d, d.url), { urls: [...VIEW_PAGES, ...LOCAL_PAGES], types: ["sub_frame"] })
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    // A provider that answers at once never commits a page, so this is how the window is known to have been there.
    if (d.type === "main_frame") {
      const a = tries.get(d.tabId)
      // A real-site window has its own, stricter watch (watchWindow), where the site's own address never counts.
      if (a && !a.real) a.away = true
      return
    }
    void spotted(d, null)
  },
  { urls: ["https://*/*client_id=*", "https://*/*SAMLRequest=*", "https://*.cloudflareaccess.com/cdn-cgi/access/login/*"], types: ["sub_frame", "main_frame"] },
)

/** The address a window may open for this site: the site itself, or its view host's way in for the one retry. */
function entryOf(open, text) {
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.origin === open.site) return { url: url.href, view: null }
  if (open.local) return null
  return open.views.includes(url.origin) && url.pathname === "/__uifb/enter" ? { url: url.href, view: url.origin } : null
}

async function starting(board, message) {
  if (running.has(board)) {
    if (message.manual === true && running.get(board).window !== undefined) forward(running.get(board))
    return
  }
  const a = { board, manual: message.manual === true, away: false }
  running.set(board, a)
  try {
    const open = await openSite(board)
    const entry = open && message.site === open.site ? entryOf(open, message.url) : null
    // The view host's way is the retry alone, which no click asks for.
    if (!entry || (a.manual && entry.view)) return void running.delete(board)
    if (!a.manual) {
      const cool = await coolOf(board, open.site)
      const cooled = await chrome.alarms.get(cool)
      const retry = Boolean(entry.view) && (await chrome.alarms.clear(await againOf(board, open.site)))
      if (cooled && !retry) return void running.delete(board)
      await chrome.alarms.create(cool, { when: Date.now() + COOLDOWN })
    }
    const real = !open.local && !entry.view
    Object.assign(a, { site: open.site, local: open.local, real, view: open.views[0], homes: real ? [open.site] : [open.site, ...open.views], from: new URL(entry.url).pathname })
    if (real) a.before = new Map((await siteCookies(open.site)).map((c) => [cookieKey(c), c.value]))
    const shape = { url: "about:blank", type: "popup", focused: true, ...SIZE }
    // Chrome refuses a place mostly off the screen, as under a board window dragged half out of it.
    const win = await chrome.windows.create({ ...shape, ...(await overBoard(board)) }).catch(() => chrome.windows.create(shape))
    a.window = win.id
    a.tab = win.tabs[0].id
    tries.set(a.tab, a)
    follow(true)
    if (real) watchWindow(a)
    a.keep = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEPALIVE)
    // Before the window goes anywhere, so the provider's return is caught however fast it comes.
    if (entry.view) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [a.tab], addRules: [ruleFor(a.tab, open.site, entry.view)] })
    await chrome.alarms.create(alarmOf(a.tab, board), { when: Date.now() + LIFETIME })
    await chrome.tabs.update(a.tab, { url: entry.url })
  } catch {
    if (a.tab === undefined) running.delete(board)
    else void finish(a, "failed")
  }
}

const atHome = (a, url) => {
  try {
    return a.homes.includes(new URL(url).origin)
  } catch {
    return false
  }
}

/**
 * Follows a real-site window at the network level: a provider that answers at once commits no page, and what the
 * site sets before it leaves (its OAuth state) must not pass for the login's result.
 */
function watchWindow(a) {
  a.flow = new Map()
  const hop = (d) => {
    if (!atHome(a, d.url)) a.away = true
  }
  const heard = (d) => {
    if (a.away || !atHome(a, d.url)) return
    for (const h of d.responseHeaders ?? []) {
      if (h.name.toLowerCase() !== "set-cookie") continue
      const c = parseSetCookie(h.value, d.url)
      if (c) a.flow.set(c.name, c.value)
    }
  }
  const filter = { urls: ["https://*/*"], types: ["main_frame"], tabId: a.tab }
  chrome.webRequest.onBeforeRequest.addListener(hop, filter)
  chrome.webRequest.onHeadersReceived.addListener(heard, filter, ["responseHeaders", "extraHeaders"])
  a.unwatch = () => {
    chrome.webRequest.onBeforeRequest.removeListener(hop)
    chrome.webRequest.onHeadersReceived.removeListener(heard)
  }
}

/** The unpartitioned cookies a request to the site carries, on any path of its host, parent domains included. */
async function siteCookies(site, at = site) {
  const host = new URL(site).hostname
  const lists = await Promise.all([chrome.cookies.getAll({ url: site }), chrome.cookies.getAll({ url: at }), chrome.cookies.getAll({ domain: host })])
  const all = new Map(lists.flat().filter((c) => !c.partitionKey && reaches(c, host)).map((c) => [cookieKey(c), c]))
  return [...all.values()]
}

/** Past the provider, a real-site window is done only when the site wrote something and the address has settled. */
function judgeReal(a, url, since) {
  a.settle = setTimeout(async () => {
    if (a.over || a.last !== url) return
    const said = landing(url)
    if (a.away && refused(url) && !a.manual) return void finish(a, "failed")
    if (said === "waiting" && Date.now() - since < WAIT_ANSWER) return judge(a, url, since)
    if (said !== "in") return
    if (a.away && sessionChanged(a.before, await siteCookies(a.site, url), a.flow)) {
      if (!a.over && a.last === url) void finish(a, "done")
      return
    }
    if (a.manual || a.offered || a.over) return
    a.offered = true
    await tell(a.board, { type: "login-offer" }).catch(() => {})
  }, SETTLE)
}

function judge(a, url, since = Date.now()) {
  clearTimeout(a.settle)
  if (!atHome(a, url)) return
  if (a.real) return judgeReal(a, url, since)
  // A 2FA step of the site's own is the person's to finish.
  if (isStep(url)) return
  a.settle = setTimeout(() => {
    const said = landing(url)
    if (a.away) {
      if (said === "waiting" && Date.now() - since < WAIT_ANSWER) return judge(a, url, since)
      // By hand the person is there to see what went wrong.
      if (said !== "in" && a.manual) return
      void finish(a, said === "in" ? "done" : "failed")
    } else if (!a.manual && a.local && said === "in" && new URL(url).pathname !== a.from) {
      // The app sent the window on by itself: a session of this browser it already had, only out of the frames' reach.
      void finish(a, "done")
    }
  }, SETTLE)
}

const committed = (d) => {
  const a = tries.get(d.tabId)
  if (!a || d.frameId !== 0) return
  clearTimeout(a.settle)
  a.last = d.url
  // A real-site window counts only an https provider, so an error page or a plain http stop is no provider visit.
  if (!atHome(a, d.url) && d.url !== "about:blank" && (!a.real || d.url.startsWith("https://"))) a.away = true
}
const loaded = (d) => {
  const a = tries.get(d.tabId)
  if (!a || d.frameId !== 0 || d.url === "about:blank") return
  a.last = d.url
  judge(a, d.url)
}
// A page that takes the provider's answer by script writes its session without going anywhere.
const cookieMoved = ({ cookie, removed }) => {
  if (removed || cookie.partitionKey) return
  for (const a of tries.values()) if (a.real && a.away && a.last && atHome(a, a.last) && reaches(cookie, new URL(a.site).hostname)) judge(a, a.last)
}

// Only while a login runs, or every page of the browser would wake the helper.
let following = false
function follow(on) {
  if (on === following) return
  following = on
  const nav = chrome.webNavigation
  for (const [event, fn] of [[nav.onCommitted, committed], [nav.onCompleted, loaded], [nav.onHistoryStateUpdated, loaded]]) {
    if (on) event.addListener(fn)
    else event.removeListener(fn)
  }
  if (on) chrome.cookies.onChanged.addListener(cookieMoved)
  else chrome.cookies.onChanged.removeListener(cookieMoved)
}

/** The key of the partition the board's frames keep cookies in, as Chrome reports it for a frame showing the app. */
async function partitionOf(board, site) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: board })) ?? []
  const devices = frames.filter((f) => f.parentFrameId === 0)
  const urlOf = (f) => {
    try {
      return new URL(f.url)
    } catch {
      return null
    }
  }
  // A frame of the board's own hosts is same-site with it and has another partition than the app's frames.
  const frame = devices.find((f) => urlOf(f)?.origin === site) ?? devices.find((f) => urlOf(f) && !isBoardHost(urlOf(f).hostname))
  return frame ? (await chrome.cookies.getPartitionKey({ tabId: board, frameId: frame.frameId })).partitionKey : null
}

/** What the login window's top level holds for this host goes into the frames' partition, where they can read it. */
async function copySession(a) {
  const key = await partitionOf(a.board, a.site)
  if (!key) return
  const host = new URL(a.site).hostname
  for (const c of await chrome.cookies.getAll({ domain: host })) {
    if (c.partitionKey || c.domain.replace(/^\./, "") !== host) continue
    await chrome.cookies.set(framedCookie(a.site, { name: c.name, value: c.value, path: c.path, httpOnly: c.httpOnly, expires: c.expirationDate }, key)).catch(() => {})
  }
}

/**
 * The key of the frames' partition on a view host. Frames all sent to a provider show none, and a view host lies
 * below the board's own site wherever a login window runs, so then it is the board page's key.
 */
async function viewPartition(a) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: a.board })) ?? []
  const frame = frames.find((f) => f.parentFrameId === 0 && f.url.startsWith(`${a.view}/`))
  return (await chrome.cookies.getPartitionKey({ tabId: a.board, frameId: frame?.frameId ?? 0 })).partitionKey
}

/** The login's cookies onto the site's view host, where the proxy hands them to the site. Returns how many. */
async function copyToView(a) {
  const key = await viewPartition(a)
  if (!key) return 0
  let copied = 0
  for (const c of await siteCookies(a.site, a.last ?? a.site)) {
    if (isBoardCookie(c.name)) continue
    const set = await chrome.cookies.set(framedCookie(a.view, { name: c.name, value: c.value, path: c.path, httpOnly: c.httpOnly, expires: c.expirationDate }, key)).catch(() => null)
    if (set) copied++
  }
  return copied
}

async function finish(a, outcome) {
  if (a.over) return
  a.over = true
  clearTimeout(a.settle)
  clearInterval(a.keep)
  a.unwatch?.()
  running.delete(a.board)
  tries.delete(a.tab)
  if (!tries.size) follow(false)
  if (a.local) await copySession(a).catch(() => {})
  // Only a login seen through the provider, or a person's click. Closing a window nobody asked for copies nothing.
  if (a.real && (outcome === "done" || (outcome === "closed" && a.manual))) {
    const copied = await copyToView(a).catch(() => 0)
    if (!copied && outcome === "done") outcome = "failed"
    const when = Date.now() + COOLDOWN
    // A window the person closed is not reopened for them by the devices meeting the login again.
    await chrome.alarms.create(await coolOf(a.board, a.site), { when })
    if (outcome === "done") {
      reloading.add(a.board)
      await chrome.alarms.create(await againOf(a.board, a.site), { when })
    }
  }
  await end(a.tab).catch(() => {})
  if (outcome !== "closed") await chrome.windows.remove(a.window).catch(() => {})
  await tell(a.board, { type: "login-finished", outcome }).catch(() => {})
}

/*
 * Local apps in the devices. The board frames them cross-site, so Chrome drops their Lax cookies, the usual kind. The
 * helper writes what the open local app sets in a device into that frame's partition instead, as the board's proxy
 * does for any other site. A form's answer that redirects has already gone on without the cookie, so the board loads
 * the devices again.
 */
async function takeCookies(d) {
  if (!isDevice(d)) return
  const lines = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value)
  if (!lines.length) return
  try {
    const open = await openSite(d.tabId)
    if (!open?.local || new URL(d.url).origin !== open.site) return
    // What another site's page in the device made the app answer is no login of this app's, as SameSite would say.
    if (d.initiator !== open.site && !(d.type === "sub_frame" && d.initiator === open.board)) return
    const { partitionKey } = await chrome.cookies.getPartitionKey({ tabId: d.tabId, frameId: d.frameId })
    for (const line of lines) {
      const cookie = parseSetCookie(line, d.url)
      if (!cookie || cookie.partitioned) continue
      if (cookie.gone) await chrome.cookies.remove({ url: `${open.site}${cookie.path}`, name: cookie.name, partitionKey })
      else await chrome.cookies.set(framedCookie(open.site, cookie, partitionKey))
    }
    if (d.type === "sub_frame" && d.method === "POST" && d.statusCode >= 300 && d.statusCode < 400) await tell(d.tabId, { type: "login-session" })
  } catch {}
}

chrome.webRequest.onHeadersReceived.addListener((d) => void takeCookies(d), { urls: LOCAL_PAGES, types: ["sub_frame", "xmlhttprequest"] }, ["responseHeaders", "extraHeaders"])
