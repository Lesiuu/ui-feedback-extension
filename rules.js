// What the helper decides without touching the browser: which pages are boards, which site a board may ask about,
// which view host belongs to that site on that board, and the one redirect rule for a login window. The background
// imports it, and so do the tests (test/extension.test.mjs).

/** The hosted board and the host below which it runs its sites, one view host per site. */
export const HOSTED = new Map([
  ["https://ui.lesiuu.com", "view.ui.lesiuu.com"],
])

const LOCAL_BOARD = /^http:\/\/(localhost|127\.0\.0\.1):(\d+)$/
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|([a-z0-9-]+\.)+localhost)$/
// The board's own hosts are never a reviewed site: a rule for one would send the board or its frames elsewhere.
const BOARD_HOST = /(^|\.)ui\.lesiuu\.com$/

/** How long a login window's rule lives at most, as long as the Worker's login window cookie. */
export const LIFETIME = 30 * 60 * 1000

/** The board's origin for a page of the board (under /board/), or null for any other page. */
export function boardOf(pageUrl) {
  let url
  try {
    url = new URL(pageUrl)
  } catch {
    return null
  }
  if (url.pathname !== "/board" && !url.pathname.startsWith("/board/")) return null
  return HOSTED.has(url.origin) || LOCAL_BOARD.test(url.origin) ? url.origin : null
}

/** The origin of a site a board may review in a login window, or null. Plain http only for this machine. */
export function siteOf(text) {
  let url
  try {
    url = new URL(String(text))
  } catch {
    return null
  }
  if (url.origin !== text) return null
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOST.test(url.hostname))) return null
  return BOARD_HOST.test(url.hostname) ? null : url.origin
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")

/** The host label of a site's view, as labelOf in views.js works it out, so the helper names the same host. */
export async function labelOf(target) {
  const name = target.replace(/^https?:\/\//, "").replace(/^file:.*\//, "file-")
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "site"
  return `${slug}-${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(target))).slice(0, 4))}`
}

/**
 * The view hosts a site may run on for a board: the hosted board's one, or for a local board server.mjs's (two
 * ports up) and wrangler dev's (below view. on the board's own port).
 */
export async function viewsOf(board, site) {
  const label = await labelOf(site)
  if (HOSTED.has(board)) return [`https://${label}.${HOSTED.get(board)}`]
  const local = LOCAL_BOARD.exec(board)
  if (!local) return []
  const port = Number(local[2])
  return [`http://${label}.localhost:${port + 2}`, `http://${label}.view.localhost:${port}`]
}

/**
 * What a board page asks for when it opens a login window, checked: { site, view } when the page is a board, the
 * site one it may review and the view host that site's own on that board, else null.
 */
export async function checkLogin(pageUrl, site, view) {
  const board = boardOf(pageUrl)
  const origin = siteOf(site)
  if (!board || !origin || origin === board || typeof view !== "string") return null
  return (await viewsOf(board, origin)).includes(view) ? { site: origin, view } : null
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The redirect for one login window: a top-level navigation of tab `tab` to the site's real origin goes to the
 * site's view host instead, with the same path and query. The browser keeps the fragment, as on any redirect
 * without one of its own. The rule's id is the tab's, so a tab has one rule at most.
 */
export function ruleFor(tab, site, view) {
  return {
    id: tab,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution: `${view}\\1` } },
    condition: { regexFilter: `^${escapeRegex(site)}(/.*)?$`, resourceTypes: ["main_frame"], tabIds: [tab] },
  }
}
