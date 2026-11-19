// Runs in pages of this machine, in every frame. When the page is a device of the hosted board,
// framed straight by the board's page, and has no overlay of its own, it adds the board's overlay, as the tag from
// Connect localhost would, so a local app needs no change to be reviewed. A page whose Content Security Policy
// allows no scripts from the board keeps refusing it: then the tag in the app is the way.
const BOARD = "https://ui.lesiuu.com"

// A frame cannot read the top page's address, but Chrome tells it the origins of the pages around it.
const around = location.ancestorOrigins
const board = window !== window.top && around?.length === 1 ? around[0] : null
const tagged = () => [...document.scripts].some((s) => /\/board\/overlay\.js([?#]|$)/.test(s.src))

if (board === BOARD && !tagged()) {
  const tag = document.createElement("script")
  tag.type = "module"
  tag.src = `${board}/board/overlay.js`
  const parent = document.head ?? document.documentElement
  parent.append(tag)
}
