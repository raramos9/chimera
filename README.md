# Chimera

A personal Linux computer in the cloud. It sleeps when nobody is using it and wakes from the laptop (`bin/chimera wake`) or the phone (the "Wake Chimera" Shortcut). Files in `/home` survive sleep. Everything else is rebuilt on wake by `cloud-init.yaml`.

You reach it as `andre@chimera` over Tailscale. The public internet can't reach it at all.

## Opening an app running on the computer

Anything listening on the computer opens from your laptop or phone at `http://chimera:<port>`. For example, a dev server on port 3000 is `http://chimera:3000`.

If the page doesn't load, the app is probably accepting visitors only from the computer itself. Many dev servers do this by default. There are two fixes:

- Start the app with its host option set to `0.0.0.0`. For Vite, that's `npm run dev -- --host 0.0.0.0`.
- Or leave the app alone and run `sudo tailscale serve --bg 3000`. Then open `https://chimera.tailed8053.ts.net`. It works only from your own devices, and it keeps working after the computer sleeps and wakes. Turn it off with `sudo tailscale serve reset`.

For Docker, `-p 3000:3000` makes a container reachable at `http://chimera:3000`. `-p 127.0.0.1:3000:3000` keeps it on the computer, which is the right pair for `tailscale serve`. Add `--restart=always` if it should come back after a wake. For anything long-lived, put the settings in a `compose.yaml` in the project folder and start it with `docker compose up -d`. Backups keep Docker volumes but not containers, so after a restore that same command is how you get the container back.

Visiting an app does not keep the computer awake. After 30 minutes with no SSH session and no `~/.keep-awake` file, it sleeps and the app goes away until the next wake.

## Running an AI agent

Claude Code is installed in the home folder (`~/.local/bin/claude`), so it and its login survive sleep. Connecting puts you in a tmux session called `main`. It survives disconnects, so close Termius whenever you like and reconnect later to find everything where you left it. Just run `claude`.

The computer stays on while Claude is working, including background tasks it started. When Claude finishes and waits for you, the usual 30-minute countdown starts. If you stop Claude with Esc, it keeps the computer on until you send it another message or quit it. An open Claude that is waiting for you costs nothing. After a sleep, run `claude --continue` in the project folder to pick the conversation back up.

`awake` is for other long commands, like `awake npm test`. While the command runs, the computer stays on even with nobody connected. When it ends, or crashes, the countdown starts. Use it too for something Claude starts that should keep running after Claude is done, like `awake npm run dev`. Anything else left running in the background doesn't keep the computer on. The Worker shuts down anything awake for 24 hours either way.

The agent runs as `andre`, who has full admin rights. Backups (below) are the safety net.

## Software updates

Each wake starts from a saved image that already has Tailscale, Docker, restic and the latest Ubuntu updates installed, which makes waking about 15 to 25 seconds faster than installing them every time. `image.yaml` lists what goes in it. Your settings and scripts stay in `cloud-init.yaml`, so changing those doesn't need a new image.

The Worker rebuilds the image once a week. It starts a throwaway build server, which installs everything and powers itself off only if every install worked. The Worker then saves it as the new image and keeps the previous one as a fallback. A wake during a build uses the previous image. If a build fails, the Worker deletes the build server after an hour and tries again the next day. To rebuild right away, for example after changing `image.yaml`, run `bin/chimera build-image` from the laptop. It starts a build and waits up to 20 minutes for the Worker to finish it.

## Backups

`/home` is backed up to the Cloudflare R2 bucket `chimera-backup` every hour while the computer is on, and again whenever it shuts down, whether it went idle, you ran `chimera sleep`, or the 24-hour limit kicked in. Caches, `node_modules`, and Docker's downloaded images are skipped. Run `sudo chimera-backup` to back up right now.

The R2 bucket has lock rules that stop anything from deleting or changing a backup, ever. The computer can add backups but can't remove them, and neither can anything running on it. Only you can change the rules, from the laptop with your Cloudflare login. Removing a rule is the only way to clean up old backups.

Everything is scrambled with the backup password before it leaves the computer. A copy is in your password manager. Without it, the backups can't be opened by anyone, including you.

### Getting files back

On the computer:

```
sudo chimera-restic snapshots
sudo chimera-restic restore latest --include /home/andre/projects/website --target /tmp/restore
sudo cat /tmp/restore/home/andre/projects/website/index.html
sudo mv /tmp/restore/home/andre/projects/website ~/projects/
sudo chown -R andre:andre ~/projects/website
sudo rm -rf /tmp/restore
```

The first command lists every backup with its time. Put a backup's ID in place of `latest` to restore from an earlier one. Restores go to `/tmp/restore` first, so nothing in your home folder is overwritten. That folder is admin-only, which is why looking inside needs `sudo`.

### Setting it up again

The R2 key and backup password live in `~/.config/chimera/backup.env` and `~/.config/chimera/backup-password` on the laptop, and on the volume in `/home/.chimera/backup/`. If you change either one, run `bin/chimera backup-keys` from the laptop to copy them over.

If the volume is ever lost, make a new one in `hil` with the same name, `chimera-home`. Everything finds the volume by that name, so no code changes. Then run `bin/chimera restore` from the laptop while the computer is asleep. It wakes the computer onto the blank volume, briefly opens public SSH, puts the latest backup back on `/home`, and restarts it so it rejoins Tailscale as `chimera` with its old SSH fingerprint. It refuses to run if the volume isn't blank. Anything changed after the last backup is lost. Docker volumes come back, but containers don't. Run `docker compose up -d` in each project folder to start them again, and images download as needed.
