# UI Feedback helper

A small Chrome extension for [UI Feedback](https://ui.lesiuu.com/docs), the board that shows a page on many devices at once. It logs the board's devices in by itself: a reviewed site's login through Google, GitHub, another OAuth provider, SAML or Cloudflare Access opens at once in a window of its own, and an app on `localhost` logs in like any other site.

## Why it is needed

On the board every reviewed site runs on a host of its own, such as `shop-example-com-b4981fa5.view.ui.lesiuu.com`, and keeps its cookies there. A provider's login goes wrong there at the very end: the provider sends the browser back to the site's registered address, `https://shop.example.com/oauth/callback?code=...&state=...`, which is the real site, not the board, and no web page can follow a navigation to another origin to fix that. Cloudflare Access, SAML and OAuth with `response_mode=form_post` cannot be sent to another host at all.

The helper runs the login where it belongs. It opens the site's **real address** in a window of its own, you log in as you always do, and once the site has set its session the helper copies the site's cookies to the site's host on the board, where the devices read them.

## Install

1. Download this repository: **Code**, then **Download ZIP**, and unpack it. Or `git clone https://github.com/Lesiuu/ui-feedback-extension`.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the folder.
3. Reload the board. **Get the login helper** leaves the **…** menu, which is how you know the board sees the helper.

## What it does, exactly

- On the board's own pages (`https://ui.lesiuu.com/board/` and a board on this machine) a content script marks the page (`data-uifb-extension` on `<html>`), so the board knows the helper is there, and passes on one message from the board: "my login window is for site X on host Y".
- The background checks every message again: it must come from a board page's top frame, and the site must be the one that page has open, a plain origin over https.

### The login

- A login starts when a device of a board (a frame right under the board's page, never a frame inside a reviewed page) is sent to one of these for the site the board has open: an https OAuth address with `client_id` and `redirect_uri` or `response_type` that returns to the site, a parent of its host or a sibling sharing all but the first label (`app.example.com` and `auth.example.com`), a Cloudflare Access login that names the site's host, or an address with `SAMLRequest` that the site's own page redirected to. **Log in to this site** in the **…** menu starts the same login by hand. The helper tells the board only that a login was met and on which page of the site: the address itself stays in the helper.
- A window opens over the board at once, on the site's real address and nowhere else. A provider that needs a password, a consent or an account choice asks for it there, and the login signs you in to the real site in this browser, as it would in a normal tab.
- The window closes by itself when all of this holds: it went through a provider over https, it is back on the site, the site has a new or changed cookie compared with before the window opened (trackers and what the site set on its way out, such as its OAuth state, do not count), and the address has stayed put for a moment. A 2FA, verification or other login step of the site keeps the window open. Back on the site with no new cookie, the window stays open for you, and closing it changes nothing.
- While the window is open the board covers its devices with a waiting screen. **Show login window** brings a lost window back, **Cancel** closes it and copies nothing, and a finished login shows a short confirmation while the devices load.
- A login that ended on an error closes the window and says so.
- One window per board tab at a time, and after an attempt no other for that site in that tab for 10 minutes, whatever came of it, so a login that fails cannot loop. **Log in to this site** always works.

### What is copied, where and why

- **What:** the cookies your browser would send to the open site's address, HttpOnly ones and those of a parent domain included. Cookies of other hosts, partitioned cookies and any name starting `__Host-uifb` are left out.
- **Where:** to the site's host on the board, in the partition of the board's device frames, each as a host-only, `Secure`, `SameSite=None` cookie with its name, value, path, HttpOnly flag and expiry. Your normal tabs of the site keep their own cookies.
- **When:** only after a login really passed through the provider in that window, or after you clicked. A window that shows a site where you already have a session copies nothing by itself: the board asks first (**Use this login**), and closing the window or **Cancel** declines. **Log in to this site** is that click too, so closing a window you opened that way copies what the site has.
- **In transit:** the devices run through the board's proxy, so these session cookies pass through it on each request to the site, like any login made on the board. The proxy forwards them to the site, does not store them and does not log them.
- **If the copy does not hold**, as with a session tied to an IP address (the proxy's address is not yours): when a device meets the same login again after a copy, one retry runs through the site's host on the board. For that window's tab alone the helper adds one session rule, which sends a `main_frame` request to the site's exact origin to the same path and query on the site's host on the board, until the window closes, the login ends or 30 minutes pass. After that retry nothing more runs by itself. Access, SAML, `form_post` and a return to another subdomain cannot go that way, so the board says the login did not carry over.
- **Good to know:** a site that rotates its session on use can sign out either the copy or your normal tab, since both now hold the same session. Sessions kept in `localStorage` are not copied, so a site that keeps its login there stays logged out in the devices.

The board shows a dev server on `localhost` straight in its frames, and the app needs the board's overlay script to talk to the board (**Connect localhost** gives the tag). With the helper it needs no tag: in pages on `localhost`, `127.0.0.1` and `*.localhost`, a second content script checks whether the page is a frame placed right in the hosted board's page (`location.ancestorOrigins` is just `https://ui.lesiuu.com`) and has no overlay tag yet, and only then adds `<script type="module" src="https://ui.lesiuu.com/board/overlay.js">`, the same tag Connect localhost gives. Opened on its own, or framed by anything else, the app is left as it is. The script runs in the page, so a page whose Content Security Policy blocks scripts from the board still blocks it: add the tag by hand or allow the board's origin in the policy.

A frame on the board is cross-site for `localhost`, so Chrome drops the app's `SameSite=Lax` cookies there, which is what keeps a login out of the devices. For the one local app the board has open, the helper writes the cookies that app sets in a device into the partition of the board's frames (`Secure`, `SameSite=None`, partitioned), and after a login in its own window it copies that host's cookies there too. Your normal tabs of the app keep their own cookies. Browsers do not separate cookies by port, so the copy holds what every app on that host name set, which is what the app gets at the top of a tab as well. Tokens an app keeps in `localStorage` are not copied.

## Permissions and why

- `declarativeNetRequest`: the one redirect rule of a retry, applied by Chrome itself. Session rules only, scoped to one tab.
- `webNavigation`: to follow the login window, and to see which tab a board's page opened.
- `webRequest`: to see a device's frame being sent to a provider's login, to see the login window pass through the provider, and to read the `Set-Cookie` of the login window and of the local app the board has open. It only watches: it blocks and changes nothing.
- `cookies`: to read the open site's cookies for the comparison and the copy above, and to write them into the partition of the board's frames. Only for the site the board has open, never for any other.
- `alarms`: to drop the rule after 30 minutes, and to remember for 10 minutes that a site had its automatic login or a copy, even if the browser put the helper to sleep meanwhile. An alarm's name holds tab numbers and a short hash of the site, nothing else.
- Content scripts on the boards' pages (the board's mark and its login window message) and on `localhost` pages (the overlay for apps framed by a board). They read nothing from the pages.
- Host permission for every https site (and `localhost` for a board on this machine): Chrome redirects a request only for an extension that has permission for its address, and the site under review can be any site. This is why Chrome says the helper can "read and change all your data on all websites". The helper reads no page, changes no page but a board's and the localhost apps a board frames, opens no window but the login of the site the board has open, copies no cookies but that site's, and redirects nothing but a retry window's visits of that one site.

## Privacy

The helper collects no data and sends nothing anywhere. It has no server, no analytics and no storage of its own: the board's message, the rule and the comparison of cookies live in the browser's memory until the window closes, and copied cookies stay in the browser's cookie jar, from where the devices send them through the board's proxy to the site. It writes nothing to the console, since the addresses and cookies it handles carry logins.

## Browsers

Chrome and other Chromium browsers (Edge, Brave, Arc) from version 132. Firefox and Safari are not supported.

## Source

This repository is a copy of `extension/` in the UI Feedback repository, published with `npm run extension:publish`.
