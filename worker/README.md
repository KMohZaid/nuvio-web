# Return relay

Carries a playback position from an external player back into the installed
iOS web app.

## Why it exists

An installed iOS web app cannot be reached by URL. iOS opens it at its own
start address and throws away the path and query, and Safari — where a
player's callback lands — is a separate storage container that is signed out
and knows nothing about what was playing. So Outplayer can report exactly
where it stopped, and there is no route for that number to reach the app.

Routing the callback through Shortcuts does not help either. A player appends
`position` to the address it was handed, so on a `shortcuts://` address it
lands beside the `text` being passed on rather than inside it, and Shortcuts
drops what it does not recognise.

This relay is the first and only point in the chain that sees the number,
because the callback reaches it as an ordinary HTTP request.

## What it holds

A token and two integers, for as long as it takes the app to ask — deleted on
collection, or after five minutes if nobody collects. It never receives what
is being watched, the stream URL, the addon, or anything about the account.

## Deploying

```bash
cd worker
npx wrangler deploy
```

Edit `ALLOWED_APP_HOSTS` in `wrangler.toml` first if the app is served from
anywhere other than the two hosts listed. A callback naming a host that is not
in that list is refused, and only those origins may read an answer back.

`SHORTCUT_NAME` must match the Shortcut installed on the device — the one that
takes text input and runs **Open URLs** on it. Copy to Clipboard is no longer
needed; the position comes back through the relay rather than the clipboard.

Then paste the deployed URL into Nuvio under **Settings → Web-only playback
handoff → Return relay**.

## The routes

- `GET /r/<token>?outcome=…&app=…&position=…&duration=…` — where the player's
  callback lands. Stores the report and returns a page that hands off to
  Shortcuts, which opens the app.
- `GET /c/<token>` — the app collecting its answer. CORS-restricted to the
  allowed hosts, and the slot is emptied on read.
