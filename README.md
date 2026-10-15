# Chimera

A personal Linux computer in the cloud. It sleeps when nobody is using it and wakes from the laptop (`bin/chimera wake`) or the phone (the "Wake Chimera" Shortcut). Files in `/home` survive sleep. Everything else is rebuilt on wake by `cloud-init.yaml`.

You reach it as `andre@chimera` over Tailscale. The public internet can't reach it at all.

## Waking by connecting

On the laptop, `ssh chimera` wakes the computer if it's asleep, waits about 30 seconds, and connects. If it's in the middle of going to sleep, it waits for the backup to finish and wakes it again. Anything else that uses SSH, like `scp` or VS Code's remote editing, does the same. This needs three lines in `~/.ssh/config`:

```
Host chimera
  User andre
  ProxyCommand ~/Projects/active/chimera/bin/chimera connect
```

An accidental `ssh chimera` keeps the computer on for the usual 30 idle minutes.

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

## Containers

Each agent or task can get its own small Linux computer, a container, inside the computer. Containers live on a second disk, `chimera-machines`, and survive sleep. A container that was running when the computer went to sleep starts again on wake. Manage them from the laptop, or from the phone in Termius, where the same commands work:

```
chimera new api-work "add rate limiting"     # a fresh container, with an optional note
chimera new api-work --repo me/my-api         # the same, with that repo cloned on its own branch
chimera run api-work -- claude -p "add rate limiting to the API"
chimera fork api-work try-redis               # an instant copy to try another idea
chimera ls                                    # what exists, what you want for each, what it came from, its note, repo and branch
chimera results try-redis                     # what the container has done so far
chimera shell try-redis                       # a terminal inside it, in tmux
chimera shell try-redis git log               # or one command
chimera stop try-redis                        # stop it without deleting it
chimera start try-redis                       # and start it again
chimera rm try-redis                          # asks you to type the name first
```

### How new, fork, start, stop and rm work

These five commands don't touch the containers directly. They tell the Worker what you want, and the computer makes it so. The Worker keeps the request even while the computer sleeps. `new`, `fork`, `start` and `rm` wake the computer if it's asleep. `stop` doesn't. It says the container will stop on the next wake and returns.

Each command then waits and shows progress, usually a few seconds on an awake computer, or about a minute when it has to wake first. It ends with the result, or with the computer's reason for refusing, like work that isn't on GitHub. Ctrl-C stops the waiting, but the request stays and still happens. Asking twice is harmless. Stopping a stopped container changes nothing.

An awake computer hears about a new request right away over a connection it keeps open to the Worker. It also checks every 2 minutes in case that connection dropped.

A request that fails, like a `new` whose repo can't be cloned, stays in place with its error, and `chimera ls` lists the error under the table. The computer doesn't retry it on its own. Run the command again, or remove the request with `chimera rm NAME`, which also frees the name for a new `chimera new`.

`chimera ls` has a WANT column with what you asked for: `running`, `stopped` or `gone`. A container made some other way, like by hand with `incus`, shows `not managed`. Nothing ever deletes or changes a container just because nobody asked for it. `chimera stop`, `start` and `rm` work on it too, and from then on it's managed.

On the computer itself, the same five commands go through the Worker the same way, using the computer's own password.

Every container starts as a copy of one called `base`, which already has Claude Code, Git, GitHub's `gh`, Docker and build tools, with you as `andre`. A copy takes about a second and shares disk space with the original until either one changes. Each container can use at most 1.5 GB of memory.

`run` starts the command in a new tmux window inside the container and returns right away, so you can disconnect. `chimera shell NAME` attaches to that tmux. From inside the computer's own tmux, press Ctrl-b twice to reach the inner one. The computer stays on while a `run` command is going, even with nobody connected, and the usual 30-minute countdown starts when it ends. Inside a container, Claude and `awake` keep the computer on the same way they do outside one. The Worker still shuts everything down after 24 hours.

### Repos and branches

Add `--repo OWNER/REPO` to `chimera new` to give a container a real project. The container clones the repo into `~/REPO` and starts a new branch called `chimera/NAME`. `chimera shell` and `chimera run` start in that folder. A fork of a container with a repo gets its own branch, `chimera/NEW-NAME`, starting from wherever the original was. Uncommitted changes come along. If the clone fails, the container is deleted and `chimera ls` shows why. Remove the request with `chimera rm NAME` to try again with the same name.

`chimera results NAME` shows what a container has done: its repo and branch, the commits on the branch, the files not yet committed, and whether everything is on GitHub. Add `--diff` to see the changes themselves. The diff leaves out files Git doesn't track yet, but the list above it shows them.

`chimera rm` checks the same things first, on the computer. If the container has uncommitted files or commits that aren't on GitHub, it lists them and refuses to delete. If it can't reach GitHub to check, it refuses too. Push the work, or add `--force` to delete anyway. `--force` skips the check and the question. `--yes` skips only the question. Containers without a repo are deleted as before.

### Giving a container a task

Add a task to a container with a repo, and Claude starts on it by itself:

```
chimera new fix-login "Make the login page reject empty passwords." --repo OWNER/REPO
```

Claude opens in a tmux window called `claude`, in the repo folder, with the task as its first message. It approves its own actions inside the container and is told to commit and push `chimera/NAME` when it's done. To watch it or type to it, run `chimera shell NAME` and switch to the `claude` window (Ctrl-b then `w`), or use "Watch Claude" on the dashboard. A fork given a task starts Claude the same way on its own branch.

`chimera ls` has an `AGENT` column. `working` means Claude is busy, `waiting` means it's done or wants an answer, and `-` means no Claude is running. While it works it keeps the computer awake. Once it's waiting, the computer sleeps after 30 idle minutes, which ends the session. Anything Claude pushed is safe on GitHub.

From the phone, a Shortcut called "New task" does the same:

1. Ask for Input, "Repo (OWNER/REPO)".
2. Ask for Input, "Short name (lowercase, dashes)".
3. Ask for Input, "Task".
4. Get Contents of URL, the wake URL with `/orders` on the end. Method POST. Header `Authorization` set to `Bearer ` followed by the wake password. Request body JSON with `action` set to `new`, plus `name`, `task` and `repo` from the three answers.
5. Show Result.

It wakes the computer if needed. A reply with a `rev` number means the order was taken. Check on it later with `chimera ls` or `chimera results NAME`.

### Giving containers your Claude and GitHub logins

Both logins go into `base`, so every container made after that has them.

1. On the computer, run `claude setup-token`. It signs in through the browser and prints a token that lasts a year. Copy it, then run `chimera secret claude` and paste it.
2. On GitHub, go to Settings, Developer settings, Personal access tokens, Fine-grained tokens. Make a token for only the repositories agents should touch, with read and write access to Contents and Pull requests. Run `chimera secret github` and paste it.
3. Run `chimera base` to rebuild `base` with them. Containers you already have keep what they had.

The tokens are stored in `~/.config/chimera/secrets` on the computer. Every container can read them, so anything running in a container could use them. Revoke them on claude.ai or GitHub if that ever worries you.

`chimera base` also picks up changes to what's installed in `base`, which is listed in `/usr/local/share/chimera/base-setup.sh` (from `cloud-init.yaml`). It takes about 90 seconds.

Containers are not backed up. Treat them as workbenches and push anything worth keeping to GitHub. Incus's own records, like which containers exist, are on `chimera-home` and are backed up.

### Opening an app running in a container

While the computer is awake, an app in a container opens from your laptop or phone at `http://NAME.ws:PORT`. A web server on port 8000 in a container called `api-work` is `http://api-work.ws:8000`. As with apps on the computer itself, the app has to listen on `0.0.0.0`, not only on `localhost`.

One-time setup, in the Tailscale admin console:

1. Under Machines, open `chimera`, choose Edit route settings, and approve the `10.171.245.0/24` route.
2. Under DNS, add a nameserver `10.171.245.1`, turn on "Restrict to domain", and enter `ws`.

On the Mac, "Use Tailscale subnets" has to be on. It already is.

Good to know:

- The names only work while the computer is awake. Opening a page doesn't wake it, so run `chimera wake` first.
- `.ws` is also a real country domain. While Tailscale is on, real `.ws` websites won't load.
- Containers can't open connections to your laptop or phone. You can still open them.

`test/names.sh` checks all of this.

## Checking on things while it sleeps

`chimera status` and `chimera ls` on the laptop don't wake the computer. They ask the Worker, which remembers the last report the computer sent. The computer sends one every 2 minutes, when it boots, after it acts on a request, and just before it shuts down. Both commands say how old the information is, for example `Computer asleep. Last report 40 min ago.` `ls` also lists commits that aren't on GitHub and uncommitted files, with how long ago they were checked. A container that is stopped keeps its last check.

Line 1 of `chimera status` is `asleep`, `waking`, `awake` or `going-to-sleep`. Line 2 is the report age, and says so if an agent was working at the time.

Set this up once. `chimera agent-key` makes a password for the computer, copies it to the computer's disk, and prints the last step:

```
chimera agent-key
cd control && npx wrangler secret put AGENT_TOKEN < ~/.config/chimera/agent-token
```

Until both are done, the computer skips its reports and `status` says `No report yet.`

### The dashboard

Open the Worker's address (https://chimera-control.ralphandrer04.workers.dev) in any browser. The first visit asks for the wake password, the same one the phone Shortcut sends, and that browser remembers it. On the iPhone, Share > Add to Home Screen makes it an app icon.

The page shows the same information as `status` and `ls` and refreshes every 10 seconds. It can wake the computer, put it to sleep, start a new task, and start, stop or delete containers. Delete lists any work that isn't on GitHub and asks before throwing it away. Sleep asks first if Claude is working. Sleep is a gentle shutdown, so the computer backs itself up before it powers off.

### Watching Claude from a browser

While the computer is awake, a running container with a task shows a "Watch Claude" button on the dashboard. It opens `https://chimera.tailed8053.ts.net:8443/?arg=NAME`, a terminal on the container's `claude` window, the same one `chimera shell NAME` shows. You can type to Claude there too.

Only devices on your tailnet can open it. There is no password, because getting onto the tailnet is the lock. Containers can't open it, and other websites can't type into it. tmux sizes the window to whichever screen used it last, so opening it on the phone narrows it on the laptop until you press a key there.

The page stops working when the computer sleeps, and opening it doesn't wake the computer. `test/watch.sh` checks all of this.

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

If the volume is ever lost, make a new one in `hil` with the same name, `chimera-home`. Everything finds the volume by that name, so no code changes. The computer won't start without `chimera-machines` too. If that disk is lost, make a new 20 GB one with that name. Its containers are gone, since they aren't backed up, and Incus still remembers the old disk, so its storage has to be set up again by hand. Then run `bin/chimera restore` from the laptop while the computer is asleep. It wakes the computer onto the blank volume, briefly opens public SSH, puts the latest backup back on `/home`, and restarts it so it rejoins Tailscale as `chimera` with its old SSH fingerprint. It refuses to run if the volume isn't blank. Anything changed after the last backup is lost. Docker volumes come back, but containers don't. Run `docker compose up -d` in each project folder to start them again, and images download as needed.
