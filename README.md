# UI Feedback helper

A small Chrome extension for [UI Feedback](https://ui.lesiuu.com/docs), the board that shows a page on many devices at once. It logs the board's devices in by itself: a reviewed site's login through Google, GitHub or another OAuth provider runs in a window of its own, out of sight when the provider needs nobody, and an app on `localhost` logs in like any other site.

## Why it is needed

On the board every reviewed site runs on a host of its own, such as `shop-example-com-b4981fa5.view.ui.lesiuu.com`, and keeps its cookies there. **Log in to this site** opens the site's login in a window on that host. Most server-side OAuth logins then go wrong at the very end: the provider sends the browser back to the site's registered address, `https://shop.example.com/oauth/callback?code=...&state=...`, which is the real site, not the board. The site's state cookie is on the board's host, so the real site refuses the callback, and no web page can follow a navigation to another origin to fix that.

The helper does it in the browser. While the board's login window is open, a top-level visit of that window to the site's real origin goes to the site's host on the board instead, with the same path, query and fragment. The provider's code is still unused (the site checks its state before it trades the code), so the board's proxy hands it to the site's server with the state cookie present, the site finishes the login as usual and sets its session on the board's host, where the devices read it.

## Install

1. Download this repository: **Code**, then **Download ZIP**, and unpack it. Or `git clone https://github.com/Lesiuu/ui-feedback-extension`.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the folder.
3. Reload the board. **Get the login helper** leaves the **…** menu, which is how you know the board sees the helper.

## What it does, exactly

- On the board's own pages (`https://ui.lesiuu.com/board/` and a board on this machine) a content script marks the page (`data-uifb-extension` on `<html>`), so the board knows the helper is there, and passes on one message from the board: "my login window is for site X on host Y".
- The background checks that message again: it must come from a board page's top frame, the site must be a plain origin over https, and the host must be exactly the one the board gives that site (`<label>.view.ui.lesiuu.com`, the label worked out from the site's origin the same way the board does). Anything else is dropped.
- The window is the tab the board's page opened a moment before (`webNavigation.onCreatedNavigationTarget` with the board's tab and top frame as its source). Windows a reviewed page opens from a device frame never count.
- For that tab alone it adds one session rule: a `main_frame` request whose address starts with the site's exact origin is redirected to the same path and query on the site's host on the board. The provider's origin, other subdomains, other tabs and requests inside pages are never touched.
- The rule goes when the window closes, when the board says the window is done, or after 30 minutes, whichever comes first.

### The login without a click

- When a device of a board (a frame right under the board's page, never a frame inside a reviewed page) goes to an https address with `client_id` and `redirect_uri` or `response_type`, and that address returns to the site the board has open, the helper tells the board. Only that the login was met and on which page of the site: the address itself stays in the helper.
- The board asks its server for a ticket and the helper opens the site in a minimized window, with the redirect above for that window's tab. The site starts its own login there with a fresh state.
- A provider that answers by itself is never seen. One that needs a password, a consent or an account choice comes forward after 4 seconds.
- Back on the site, with the page loaded, the window closes and the devices load again. A login that ended on an error or a login page closes too and says so.
- One window per board tab at a time, and after an attempt no other for that site in that tab for 10 minutes, whatever came of it, so a login that fails cannot loop. **Log in to this site** in the **…** menu always works.

The board shows a dev server on `localhost` straight in its frames, and the app needs the board's overlay script to talk to the board (**Connect localhost** gives the tag). With the helper it needs no tag: in pages on `localhost`, `127.0.0.1` and `*.localhost`, a second content script checks whether the page is a frame placed right in the hosted board's page (`location.ancestorOrigins` is just `https://ui.lesiuu.com`) and has no overlay tag yet, and only then adds `<script type="module" src="https://ui.lesiuu.com/board/overlay.js">`, the same tag Connect localhost gives. Opened on its own, or framed by anything else, the app is left as it is. The script runs in the page, so a page whose Content Security Policy blocks scripts from the board still blocks it: add the tag by hand or allow the board's origin in the policy.

A frame on the board is cross-site for `localhost`, so Chrome drops the app's `SameSite=Lax` cookies there, which is what keeps a login out of the devices. For the one local app the board has open, the helper writes the cookies that app sets in a device into the partition of the board's frames (`Secure`, `SameSite=None`, partitioned), and after a login in its own window it copies that host's cookies there too. Your normal tabs of the app keep their own cookies. Browsers do not separate cookies by port, so the copy holds what every app on that host name set, which is what the app gets at the top of a tab as well. Tokens an app keeps in `localStorage` are not copied.

## Permissions and why

- `declarativeNetRequest`: the one redirect rule, applied by Chrome itself. Session rules only, scoped to one tab.
- `webNavigation`: to see which tab the board's page just opened, so the rule is tied to the login window and nothing else.
- `webRequest`: to see a device's frame being sent to a provider's authorize address, and the `Set-Cookie` of the local app the board has open. It only watches: it blocks and changes nothing.
- `cookies`: to write a local app's cookies into the partition of the board's frames. Only for the local app the board has open, never for any other site.
- `alarms`: to drop the rule after 30 minutes, and to remember for 10 minutes that a site had its automatic login, even if the browser put the helper to sleep meanwhile. An alarm's name holds tab numbers and a short hash of the site, nothing else.
- Content scripts on the boards' pages (the board's mark and its login window message) and on `localhost` pages (the overlay for apps framed by a board). They read nothing from the pages.
- Host permission for every https site (and `localhost` for a board on this machine): Chrome redirects a request only for an extension that has permission for its address, and the site under review can be any site. This is why Chrome says the helper can "read and change all your data on all websites". The helper reads no page, changes no page but a board's and the localhost apps a board frames, opens no window but the login of the site the board has open, and redirects nothing but the login window's visits of that one site.

## Privacy

The helper collects no data and sends nothing anywhere. It has no server, no analytics and no storage of its own: the board's message and the rule live in the browser's memory until the window closes, and a local app's cookies stay in the browser's cookie jar. It writes nothing to the console, since the addresses it handles carry login codes.

## Browsers

Chrome and other Chromium browsers (Edge, Brave, Arc) from version 132. Firefox and Safari are not supported.

## Source

This repository is a copy of `extension/` in the UI Feedback repository, published with `npm run extension:publish`.
