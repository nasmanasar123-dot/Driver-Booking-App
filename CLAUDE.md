# Driver Booking

On-demand driver service for Kochi (customers' own cars). See README.md for how the app works.

- Monorepo (npm workspaces): `apps/api` (Fastify + SQLite, TypeScript run directly by Node 24), `apps/customer`, `apps/driver`, `apps/admin` (React + Vite PWAs), `packages/shared`.
- Local: `npm run dev` (API :4000, apps :5173/:5174/:5175), `npm test`, `npm run typecheck`, `npm run build`.
- All API routes live under `/api`. Money is integer paise; timestamps are ISO UTC; times shown in IST.

## Deployment

Shared course server (about 15 students). Full guide: `apps/deploy-guide.md`.

| | |
|---|---|
| Server | 187.127.162.81 (Ubuntu 26.04) |
| SSH | `ssh nasmanasar123@187.127.162.81` (key login) |
| App name | `driverbooking` |
| Port | 3602 (127.0.0.1 only) |
| Address | https://driverbooking-nasmanasar123.dhilber.in |
| Code | `~/apps/driverbooking/` (git clone of https://github.com/nasmanasar123-dot/Driver-Booking-App) |
| Database | `~/data/driverbooking/driverbooking.db` |
| Backups | `~/data/driverbooking/backups/` (cron, nightly at 21:18 UTC, kept 14 days) |
| Settings and secrets | `~/.config/driverbooking.env` (chmod 600) |
| Service | `~/.config/systemd/user/driverbooking.service` (copy of `deploy/driverbooking.service`) |

One address serves everything: customer app at `/`, driver app at `/driver/`, admin at `/admin/`, API at `/api/`.
Razorpay webhook: `https://driverbooking-nasmanasar123.dhilber.in/api/payments/razorpay/webhook`.

### Updating

After pushing to GitHub:

```
ssh nasmanasar123@187.127.162.81 "cd ~/apps/driverbooking && git pull && npm ci && npm run build && systemctl --user restart driverbooking"
```

Then check `systemctl --user status driverbooking --no-pager` and open the address.
Logs: `journalctl --user -u driverbooking -n 50 --no-pager`.

Create an admin on the server:

```
ssh nasmanasar123@187.127.162.81 "cd ~/apps/driverbooking && set -a && . ~/.config/driverbooking.env && set +a && node apps/api/scripts/create-admin.ts you@gmail.com 'Your Name'"
```

### Server rules

1. No sudo, apt or `npm install -g`. If something needs root, ask the instructor.
2. Stay inside /home/nasmanasar123; never touch anything you didn't create (other students' apps, the `tuition` app).
3. Listen on 127.0.0.1 only, ports 3600–3699 only (3600 tuition, 3601 quickbill, 3602 driverbooking), including test runs.
4. Don't touch the web server, firewall or DNS.
5. Secrets only in `~/.config/driverbooking.env` on the server: never in git or this file.
6. Keep apps running with `systemctl --user` services (not pm2, nohup, screen or `&`).
