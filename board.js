// Runs on the board's pages only. It tells the board that the helper is here, before any of the board's scripts
// run, and carries the word between the board and the background, which checks all of it again.
document.documentElement.dataset.uifbExtension = chrome.runtime.getManifest().version

function relay(message) {
  // An extension updated under an open board has no background for this page any more.
  try {
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {}
}

// Events of the board's own document, which no device frame can send. The detail is JSON text, as an object of
// the page's would not reach this script's world.
const detailOf = (e) => {
  try {
    return JSON.parse(e.detail)
  } catch {
    return null
  }
}

document.addEventListener("uifb:login-window", (e) => {
  const detail = detailOf(e)
  if (typeof detail?.site === "string" && typeof detail?.view === "string") relay({ type: "login-window", site: detail.site, view: detail.view })
})
document.addEventListener("uifb:login-window-closed", () => relay({ type: "login-window-closed" }))
document.addEventListener("uifb:login-forward", () => relay({ type: "login-forward" }))
document.addEventListener("uifb:login-use", () => relay({ type: "login-use" }))
document.addEventListener("uifb:login-reloaded", () => relay({ type: "login-reloaded" }))
document.addEventListener("uifb:login-cancel", () => relay({ type: "login-cancel" }))
document.addEventListener("uifb:login-ask", () => relay({ type: "login-ask" }))
document.addEventListener("uifb:login-start", (e) => {
  const detail = detailOf(e)
  if (typeof detail?.site === "string" && typeof detail?.url === "string") relay({ type: "login-start", site: detail.site, url: detail.url, manual: detail.manual === true })
})

// The background asks which site the board has open, as it may have slept since the board last said.
const TO_BOARD = new Set(["login-seen", "login-finished", "login-session", "login-offer", "login-lost", "login-opened", "login-state", "login-none"])
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  if (message?.type === "open-site") reply(document.documentElement.dataset.uifbSite ?? null)
  else if (TO_BOARD.has(message?.type)) document.dispatchEvent(new CustomEvent(`uifb:${message.type}`, { detail: JSON.stringify(message) }))
})
