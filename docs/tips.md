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

```
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
