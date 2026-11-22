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

/** How long after an automatic login a site gets no other, whatever came of it, so a login that fails cannot loop. */
export const COOLDOWN = 10 * 60 * 1000

/** Whether a site runs on this machine, where the board frames it straight and its Lax cookies stay out of the frame. */
export function isLocal(site) {
  try {
    return LOCAL_HOST.test(new URL(site).hostname)
  } catch {
    return false
  }
}

/** Whether a host is one of the board's own, which a frame can share a cookie partition with. */
export const isBoardHost = (host) => BOARD_HOST.test(host)

/**
 * An OAuth or OIDC authorize address over https: { back } with the origin its redirect_uri returns to, null when it
 * names none and the provider uses the one registered. Anything else is null.
 */
export function authorizeOf(text) {
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const q = url.searchParams
  if (url.protocol !== "https:" || !q.get("client_id") || !(q.has("redirect_uri") || q.has("response_type"))) return null
  if (!q.has("redirect_uri")) return { back: null }
  try {
    return { back: new URL(q.get("redirect_uri")).origin }
  } catch {
    return null
  }
}

// The last part of a path that is still the way in, not a page behind it.
const WAY_IN = /(^|\/)(log-?in|sign-?in|auth|oauth|sso|saml2?|acs|callback|error|2fa|mfa|otp|verify|challenge)\/?$/i
// A step of the site's own after the provider, where the person still has something to type.
const STEP = /(^|\/)(2fa|mfa|otp|verify|challenge)\/?$/i

/**
 * What a page the login window came back to says: "in" past the login, "waiting" while the address still carries
 * the provider's answer for the page's script to take, "failed" on an error or a login page again.
 */
export function landing(text) {
  const url = new URL(text)
  const q = url.searchParams
  if (q.has("error")) return "failed"
  // Access answers its own return with a redirect to the page, so this address is never where a login ends.
  if (q.has("code") || /(^#|&)(code|access_token|id_token)=/.test(url.hash) || url.pathname === "/cdn-cgi/access/authorized") return "waiting"
  return WAY_IN.test(url.pathname) ? "failed" : "in"
}

/** Whether the address says the provider or the site refused the login, not just that it is not over yet. */
export const refused = (text) => new URL(text).searchParams.has("error")

/** Whether a page is a 2FA or similar step of the site's own, which the window stays open for. */
export const isStep = (text) => STEP.test(new URL(text).pathname)

const ACCESS_HOST = /^[a-z0-9-]+\.cloudflareaccess\.com$/
const ACCESS_PATH = /^\/cdn-cgi\/access\/login\/([^/]+)\/?$/
// Suffixes under which two names are different owners, the common ones: a sibling there is nobody's subdomain.
const SHARED_SUFFIX = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/
const ownable = (host) => host.includes(".") && !SHARED_SUFFIX.test(host) && !/^[\d.]+$/.test(host)
const parentOf = (host) => host.split(".").slice(1).join(".")

/** Whether `other` is `host`, a parent of it, or a sibling sharing all but the first label. */
export function sameFamily(host, other) {
  if (host === other) return true
  if (/^[\d.]+$/.test(host)) return false
  if (host.endsWith(`.${other}`)) return ownable(other)
  return parentOf(host) === parentOf(other) && ownable(parentOf(host))
}

/** Whether an address can be a provider's login at all, before anything is asked of the board. */
export function loginLike(text) {
  if (authorizeOf(text)) return true
  try {
    const url = new URL(text)
    return url.protocol === "https:" && (url.searchParams.has("SAMLRequest") || (ACCESS_HOST.test(url.hostname) && ACCESS_PATH.test(url.pathname)))
  } catch {
    return false
  }
}

/**
 * Whether a device sent to `text` meets a login of the open site: null when not, else { viewable }, true when the
 * provider's return could also be taken on the view host by a redirect rule, the fallback for a session that does not
 * survive the copy. Access, SAML, form_post and a return to another host can only come back to the real site.
 */
export function loginOf(text, { site, views = [], local = false, from = null }) {
  if (!loginLike(text)) return null
  const url = new URL(text)
  const host = new URL(site).hostname
  if (ACCESS_HOST.test(url.hostname)) return ACCESS_PATH.exec(url.pathname)?.[1].toLowerCase() === host ? { viewable: false } : null
  if (url.searchParams.has("SAMLRequest")) return (local ? from === site : views.includes(from)) ? { viewable: false } : null
  const { back } = authorizeOf(text)
  const formPost = url.searchParams.get("response_mode") === "form_post"
  if ((back ?? from) === site || (!back && views.includes(from))) return { viewable: !formPost }
  if (back && views.includes(back)) return { viewable: false }
  return back?.startsWith("https://") && !local && sameFamily(host, new URL(back).hostname) ? { viewable: false } : null
}

// What sites and their scripts set on any visit, logged in or not, so it says nothing about a login.
const NOISE = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|__utm|_uet|_clck|_clsk|__cf_bm|_cfuvid|cf_clearance|__hs|hubspot|ajs_|amplitude|mp_|intercom|_pk_|_tt_|optanonconsent|cookieconsent)/i

/** One cookie's place in a jar, which is what makes it the same cookie. */
export const cookieKey = (c) => `${c.name}\n${c.domain}\n${c.path}`

/**
 * Whether the site's cookies now hold something the login wrote: new or changed against `before` (key to value), not
 * a tracker's, and not what the site set on the way out (`flow`, name to value), such as its OAuth state.
 */
export function sessionChanged(before, now, flow = new Map()) {
  return now.some((c) => !c.partitionKey && !NOISE.test(c.name) && before.get(cookieKey(c)) !== c.value && flow.get(c.name) !== c.value)
}

/**
 * Whether the site holds a cookie of its own that this window's visit did not just hand out (`flow`), so the browser
 * may already be signed in. A session that is sent again on every answer was there `before`, so it still counts.
 */
export function holdsSession(before, now, flow = new Map()) {
  return now.some((c) => !c.partitionKey && !NOISE.test(c.name) && (before.has(cookieKey(c)) || flow.get(c.name) !== c.value))
}

/** Whether a cookie with these attributes is one a request to `host` carries. */
export function reaches(c, host) {
  const domain = c.domain.replace(/^\./, "")
  return c.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`)
}

/** Names the helper never writes onto a view host: the Worker's own cookies there. */
export const isBoardCookie = (name) => /^__host-uifb/i.test(name)

/**
 * One Set-Cookie line of a response to `pageUrl`: { name, value, path, httpOnly, expires, gone, partitioned }, or
 * null when it names no cookie. `expires` is in seconds, absent for a session cookie.
 */
export function parseSetCookie(line, pageUrl, now = Date.now()) {
  const [pair, ...rest] = String(line).split("\x3b")
  const eq = pair.indexOf("=")
  if (eq < 1) return null
  const attrs = new Map(
    rest.map((part) => {
      const at = part.indexOf("=")
      return at < 0 ? [part.trim().toLowerCase(), ""] : [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()]
    }),
  )
  const given = attrs.get("path")
  const path = given?.startsWith("/") ? given : new URL(pageUrl).pathname.replace(/\/[^/]*$/, "") || "/"
  const age = attrs.has("max-age") ? Number(attrs.get("max-age")) : NaN
  const date = attrs.has("expires") ? Date.parse(attrs.get("expires")) : NaN
  const at = Number.isFinite(age) ? now + age * 1000 : date
  return {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    path,
    httpOnly: attrs.has("httponly"),
    partitioned: attrs.has("partitioned"),
    gone: Number.isFinite(at) && at <= now,
    ...(Number.isFinite(at) ? { expires: Math.floor(at / 1000) } : {}),
  }
}

/** What chrome.cookies.set takes for a cookie of a local site in the partition of the board's frames. */
export function framedCookie(site, cookie, partitionKey) {
  const { name, value, path, httpOnly, expires } = cookie
  return { url: `${site}${path}`, name, value, path, httpOnly, secure: true, sameSite: "no_restriction", partitionKey, ...(expires ? { expirationDate: expires } : {}) }
}
