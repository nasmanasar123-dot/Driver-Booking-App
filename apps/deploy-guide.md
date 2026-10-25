# Deploy guide: shared course server

This guide is for Claude Code. It explains how to deploy this student's Node.js app to a shared Ubuntu server that about 15 students use. Read all of it before running anything on the server, and follow the rules exactly.

## This student's server details

| | |
|---|---|
| Server | 187.127.162.81 (Ubuntu 26.04) |
| Username | nasmanasar123 |
| SSH | `ssh nasmanasar123@187.127.162.81` (key login, already set up) |
| Ports | 3600–3699 (use only these) |

## This student's apps

Each course app has a fixed name, port and web address. Use exactly these. The app name is the `<app>` in the steps below.

| App | Port | Web address |
|---|---|---|
| tuition | 3600 | https://nasmanasar123.dhilber.in |
| driverbooking | 3602 | https://driverbooking-nasmanasar123.dhilber.in |

Port 3601 is kept for the billing app (`quickbill`); don't use it for anything else. The same list is on the server in `~/DEPLOY-INFO.txt`.

Already installed: Node.js 24, npm 11, git, sqlite3, and gcc/make/python3 (for native modules such as better-sqlite3). HTTPS for the addresses above is already set up by the instructor.

## Rules

1. **No sudo or root.** Never run `sudo`, `apt` or `npm install -g`. If something really needs root, stop and tell the student to ask the instructor.
2. **Stay inside /home/nasmanasar123.** Never read, change, stop or kill anything you didn't create. Other students' apps run on this server.
3. **Listen on 127.0.0.1 only**, on a port from 3600–3699. Never 0.0.0.0, and never a port outside this range, including test runs.
4. **Don't touch the web server, firewall or DNS.** The instructor owns them.
5. **Keep secrets out of git and out of CLAUDE.md.** Passwords and keys go only in `~/.config/<app>.env` on the server (chmod 600).
6. **Keep apps running with `systemctl --user` services**, not pm2, nohup, screen or `&`.

## Running commands over SSH

- Run commands from the student's computer with `ssh nasmanasar123@187.127.162.81 "<command>"`. Commands must be non-interactive.
- On the first connection, add `-o StrictHostKeyChecking=accept-new` so SSH doesn't stop to ask about the server's fingerprint.
- To create a file on the server, write it on the student's computer and copy it with `scp <file> nasmanasar123@187.127.162.81:<path>`. This works the same on Mac and Windows; long heredocs inside `ssh "..."` break easily, especially in PowerShell.

## Folder layout (one set per app)

Below, `<app>` means the app's name from the table above, such as `tuition` or `driverbooking`, and `<port>` means its port.

| What | Where |
|---|---|
| Code (git clone) | `~/apps/<app>/` |
| SQLite database | `~/data/<app>/<app>.db` |
| Backups | `~/data/<app>/backups/` |
| Settings and secrets | `~/.config/<app>.env` (chmod 600) |
| Service file | `~/.config/systemd/user/<app>.service` |

Keep the database outside the code folder, so `git pull` never touches it.

## First deploy

### 1. Prepare the app (on the student's computer)

- Listen on `process.env.PORT`, on host `process.env.HOST || '127.0.0.1'`.
- Read the database path from `process.env.DB_PATH`, and create its folder if it's missing.
- If the app uses sessions or secure cookies, add `app.set('trust proxy', 1)`. HTTPS ends at the instructor's proxy, which passes plain HTTP to the app.
- Commit `package.json` and `package-lock.json`. Don't commit `node_modules`, `.env` or `.db` files.
- Commit and push to GitHub.

### 2. Get the code onto the server

- **Public repo:** `git clone https://github.com/<owner>/<repo>.git ~/apps/<app>`
- **Private repo:** follow "Private repos" below.

### 3. Install

```
cd ~/apps/<app> && npm ci
```

Use `npm install` instead if there's no `package-lock.json`. If `package.json` has a `build` script, run `npm run build` too.

### 4. Settings file

Create `~/.config/<app>.env`:

```
PORT=<port>
HOST=127.0.0.1
NODE_ENV=production
DB_PATH=/home/nasmanasar123/data/<app>/<app>.db
```

Add any other settings the app needs. For an admin password, ask the student for it and don't print it back. Then run:

```
chmod 600 ~/.config/<app>.env && mkdir -p ~/data/<app>/backups
```

### 5. Service

Create `~/.config/systemd/user/<app>.service`:

```ini
[Unit]
Description=<app>

[Service]
WorkingDirectory=%h/apps/<app>
EnvironmentFile=%h/.config/<app>.env
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

Change `server.js` to the app's entry file, or use `ExecStart=/usr/bin/npm start`. Then run:

```
systemctl --user daemon-reload && systemctl --user enable --now <app>
```

### 6. Check

- `systemctl --user status <app> --no-pager` should say `active (running)`.
- `curl -s http://127.0.0.1:<port>` should return the app's page.
- Ask the student to open the app's web address in a browser.
- Logs: `journalctl --user -u <app> -n 50 --no-pager`

### 7. Daily backup

Add this line to the crontab with `(crontab -l 2>/dev/null; echo '<line>') | crontab -` (`crontab -e` is interactive, so don't use it):

```
18 21 * * * sqlite3 /home/nasmanasar123/data/<app>/<app>.db ".backup /home/nasmanasar123/data/<app>/backups/<app>-$(date +\%F).db" && find /home/nasmanasar123/data/<app>/backups -name '*.db' -mtime +14 -delete
```

It backs up every night a few minutes after 21:00 UTC (early morning in India; each student has a different minute so backups don't all run at once) and keeps 14 days. The `\%` is needed in crontab.

### 8. Record it

Add a "Deployment" section to the project's CLAUDE.md with the server, username, app name, port, address, folder paths, the update steps below and the rules above. Never put passwords, keys or other secrets there.

## Updating the app

After the changes are pushed to GitHub:

```
cd ~/apps/<app> && git pull && npm ci && systemctl --user restart <app>
```

Run `npm run build` before the restart if the app has a build step. Then check the status and the address again.

## Private repos (read-only deploy key)

1. On the server, create a key for this one repo:
   `ssh-keygen -t ed25519 -N "" -C "nasmanasar123-<app>" -f ~/.ssh/deploy_<app>`
2. Add this to `~/.ssh/config` on the server (create it with chmod 600 if it's missing):
   ```
   Host github-<app>
     HostName github.com
     User git
     IdentityFile ~/.ssh/deploy_<app>
     IdentitiesOnly yes
   ```
3. Add the public key (`~/.ssh/deploy_<app>.pub`) to the repo as a **read-only** deploy key, in one of two ways:
   - With the GitHub CLI on the student's computer: copy the key down, then run `gh repo deploy-key add <file> --repo <owner>/<repo> --title "course server"`.
   - Or the student pastes it at GitHub → the repo → Settings → Deploy keys → Add deploy key, with "Allow write access" left unticked.
4. Trust GitHub once: `ssh -o StrictHostKeyChecking=accept-new -T git@github-<app>`. It prints "successfully authenticated … does not provide shell access", which means it worked.
5. Clone using the alias: `git clone git@github-<app>:<owner>/<repo>.git ~/apps/<app>`

## More apps

- Apps in the table above already have a port and web address. Follow the same steps with that `<app>` name and port.
- For an app that isn't in the table, use a free port in 3600–3699 that isn't listed above. Check with `ss -ltn`. It lists every user's ports, so only pick from your range. It has no web address: the student asks the instructor for `<app>-nasmanasar123.dhilber.in` and gives the port. Until then, test it with `curl` on the server.

## Troubleshooting

- **502 at the address:** the app isn't running, or it isn't on 127.0.0.1 at its port from the table. Check the status and logs.
- **`npm ci` fails building a native module:** delete `node_modules` and run `npm ci` again. If it still fails, show the student the error.
- **npm warns about "install-scripts" and a native module (such as better-sqlite3) won't load:** run `npm install-scripts approve <pkg>`, then `npm rebuild <pkg>`.
- **Permission denied outside your home folder:** that's expected. Don't try to work around it.
- **Anything that needs sudo:** stop and tell the student to ask the instructor.
