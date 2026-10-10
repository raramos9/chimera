# Chimera

A personal Linux computer in the cloud. It sleeps when nobody is using it and wakes from the laptop (`bin/chimera wake`) or the phone (the "Wake Chimera" Shortcut). Files in `/home` survive sleep. Everything else is rebuilt on wake by `cloud-init.yaml`.

You reach it as `andre@chimera` over Tailscale. The public internet can't reach it at all.

## Opening an app running on the computer

Anything listening on the computer opens from your laptop or phone at `http://chimera:<port>`. For example, a dev server on port 3000 is `http://chimera:3000`.

If the page doesn't load, the app is probably accepting visitors only from the computer itself. Many dev servers do this by default. There are two fixes:

- Start the app with its host option set to `0.0.0.0`. For Vite, that's `npm run dev -- --host 0.0.0.0`.
- Or leave the app alone and run `sudo tailscale serve --bg 3000`. Then open `https://chimera.tailed8053.ts.net`. It works only from your own devices, and it keeps working after the computer sleeps and wakes. Turn it off with `sudo tailscale serve reset`.

For Docker, `-p 3000:3000` makes a container reachable at `http://chimera:3000`. `-p 127.0.0.1:3000:3000` keeps it on the computer, which is the right pair for `tailscale serve`. Add `--restart=always` if it should come back after a wake.

Visiting an app does not keep the computer awake. After 30 minutes with no SSH session and no `~/.keep-awake` file, it sleeps and the app goes away until the next wake.
