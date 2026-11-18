// Runs on the board's pages only. It tells the board that the helper is here, before any of the board's scripts
// run, and passes on the board's word about its login window to the background, which checks it again.
document.documentElement.dataset.uifbExtension = chrome.runtime.getManifest().version

function relay(message) {
  // An extension updated under an open board has no background for this page any more.
  try {
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {}
}

// Events of the board's own document, which no device frame can send. The detail is JSON text, as an object of
// the page's would not reach this script's world.
document.addEventListener("uifb:login-window", (e) => {
  let detail
  try {
    detail = JSON.parse(e.detail)
  } catch {
    return
  }
  if (typeof detail?.site === "string" && typeof detail?.view === "string") relay({ type: "login-window", site: detail.site, view: detail.view })
})
document.addEventListener("uifb:login-window-closed", () => relay({ type: "login-window-closed" }))
