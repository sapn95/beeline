# Tips

Things that are not bugs, and not Beeline's to fix, but that make it behave
oddly until you know about them. Each one is written down here because it cost
somebody an afternoon.

## You have to sign in again after every Firefox restart

**Symptom.** Every time Firefox starts, importing from My Apps — or opening any
app — sends you back to the Microsoft login, in every container.

**Cause.** Firefox is set to clear cookies when it closes. That empties every
container's cookie jar along with everything else, so nothing is signed in
any more. It has nothing to do with containers or with Beeline; the same
setting logs you out of every site you use.

**Fix.** `about:preferences#privacy` → **History** → set _"Firefox will:"_ to
**Use custom settings for history**, then clear the checkbox
**"Clear cookies and site data when Firefox is closed"**. Restart Firefox once.

If you want to keep the setting and make an exception instead, **Manage
Exceptions…** on the same screen takes these three:

```text
https://login.microsoftonline.com
https://myapplications.microsoft.com
https://launcher.myapps.microsoft.com
```

> Not verified: whether a cookie exception applies **per container** or only to
> the ordinary context. If sign-ins still evaporate after adding them, clear the
> checkbox instead.

Note that this preference is synced. With Firefox Sync on, it can come back from
another machine.

## Renaming a container does not break anything

Beeline reads container names live and listens for changes, so a rename shows up
on every badge and in every picker straight away — no reload. The apps are keyed
by the container's **id**, which does not change when you rename it.

Rename them in `about:preferences#general` → **Tabs** → **Container Tabs** →
**Settings…**, or from the Multi-Account Containers add-on.

## An app you imported into a container opens as the wrong account

Two things to check, in this order.

1. **Does the row carry a container badge?** No badge means the app is not
   pinned to a container and opens in the ordinary context. Import it again with
   the right container picked under **Read**, or add it by hand with the
   container chosen.
2. **Was the `cookies` permission refused?** Beeline asks for it the first time
   you pick a container. Without it Firefox ignores the container and opens the
   app in the ordinary context — the badge would then be a promise Beeline
   cannot keep, so it says so and adds the app without a container instead.

## "Open this site in your assigned Container?" appears when you launch

That page is not Beeline. The address bar says whose it is:

```text
moz-extension://<uuid>/confirm-page.html?url=https%3A%2F%2Flogin.microsoftonline.com%2F…
```

It belongs to **Multi-Account Containers** (`@testpilot-containers`), and it
appears because that add-on has an _"Always open this site in …"_ assignment on
a host Beeline's launch passes through. A My Apps launch starts at
`launcher.myapps.microsoft.com/api/signin/…` and redirects through
`login.microsoftonline.com`, so an assignment on the sign-in host fires on every
launch made from any other container.

**Assigning `login.microsoftonline.com` breaks more than it fixes.** It is the
one host every Microsoft account signs in through, so pinning it to a single
container means a sign-in that starts in container A is pulled into container B
mid-redirect. The test cookie is then set in one jar and read from another, and
Entra reports _"Your browser is currently set to block cookies"_ — which sounds
like a browser setting and is not.

**The fix is to remove that one assignment**, not to answer the question. Open
`https://login.microsoftonline.com` in a tab, click the Containers toolbar
button, and untick _"Always Open This Site in …"_. Assignments on ordinary
application hosts are fine and worth keeping; it is only the shared sign-in host
that has to stay unassigned.

Ticking _"Remember my decision for this site"_ on that page records an exception
for the container you are in rather than removing the assignment, so the next
container you launch from asks again.

Beeline does not override it. The assignment belongs to another add-on and is
something you asked for; an app launcher that quietly defeated it would be a
worse bug than the interruption.

## The import "fails" when you are not signed in yet

It no longer does, as of v0.6.0. It waits — up to ten minutes — and the list
shows _"Waiting for you to sign in to My Apps…"_ while it does. Only when the
grid finally appears does the two-minute reading budget start.

Before that version the wait came out of the reading budget, so an import
started before signing in burnt its time on the login form and then reported
"No apps found".

## Moving your apps between two installs

A temporary add-on loaded from `about:debugging` and the one installed from the
store are **two separate extensions** with separate storage. Your app list does
not travel between them.

- **Export JSON** from one and **Import JSON** into the other. Everything comes
  back in as a _manual_ app, deliberately: a file is not a browser, and a
  restored backup must not be prunable by the next sync. Containers survive only
  if this browser really has a container with that id.
- Or just import from My Apps again, per container. Slower, but the apps come
  back tagged `myapps`, which is what lets the automatic sync maintain them.

## Links opened from other apps land in the wrong container

**What Firefox already does.** When another application hands Firefox a URL, it
guesses a container for you: it looks for an already-open tab on the same host
and reuses that tab's container. From `URILoadingHelper.sys.mjs`:

> _"Given a URI, guess which container to use to open it. This is used for
> external openers as a quality of life improvement (e.g. to open a document
> into the container where you are logged in to the service that hosts it)."_

This is on by default. Often it is what you wanted; when it is not, it is
invisible. Turn it off in `about:config`:

```ini
browser.link.force_default_user_context_id_for_external_opens = true
```

**Why Beeline does not offer to ask you instead.** Because no extension can
reliably tell that a link came from another application. Firefox computes the
flag internally — `isExternal` in `BrowserDOMWindow.sys.mjs` — and never exposes
it to extensions. What an extension does see is `transitionType: "link"`, which
is byte-identical to an ordinary click on a page. The only thing left is a
guess ("no opener tab, no origin URL"), and that guess also fires for the
address bar, bookmarks, session restore and any other add-on opening a tab.

It is not an effort question. Mozilla's own bug for this
([1774127](https://bugzilla.mozilla.org/show_bug.cgi?id=1774127)) has been open
since 2022, and the equivalent prompt in Mozilla's own Multi-Account Containers
has been [broken for links from Thunderbird and Slack](https://github.com/mozilla/multi-account-containers/issues/2689)
since 2024.

Doing it anyway would cost the extension its **"Access your data for all
websites"** permission — Beeline's only host access today is one Microsoft page,
and [PRIVACY.md](../PRIVACY.md) says so. That is a poor trade for a guess.

Two add-ons do attempt it: **ContainerGate** and **Ask for Container**. Both
hold `<all_urls>` and blocking `webRequest`, both are one-author projects with
single-digit user counts, and neither offers "copy the URL instead". Read their
source before trusting them with every page you visit.

## Chrome: opening a link as a different profile

Chrome has no equivalent of Firefox containers, and no extension can reach
another Chrome profile — the isolation is enforced in Chromium itself, not by
convention. Beeline hides every container control on Chrome for that reason.

Chrome does have its own answer, built in since Chrome 48: **right-click a link
→ "Open Link as ‹Profile›"**. It costs nothing and no add-on can do better.

## The keyboard shortcut does nothing

Another extension already claimed it. Firefox and Chrome both drop a suggested
shortcut silently when it is taken, which is why **Manage apps** shows the key
your browser _actually_ has bound rather than the one in the manifest. Use
**Change…** next to it to pick another.
