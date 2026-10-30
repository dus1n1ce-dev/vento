# Borcelle

Restaurant website with online reservations, a password-protected menu manager, and a PostgreSQL-backed booking inbox.

## Run locally

Requires Node.js 20.19.0 or newer (Render uses the version in `.node-version`).

```powershell
npm ci
npm run dev
```

The server loads settings from `.env` when present. Create that file with local credentials:

```env
BORCELLE_ADMIN_LOGIN=Adminchik
BORCELLE_ADMIN_PASSWORD=replace-with-a-strong-password
```

Open http://127.0.0.1:3000. Without `DATABASE_URL`, local development stores menu items and reservations in `data/menu.json` and `data/bookings.json`. Set `DATABASE_URL` to use PostgreSQL locally. The initial menu is seeded on first startup.

## Deploy to Render

1. Push this project to a GitHub repository you control.
2. In Render, create a **Blueprint** and select that repository. Render reads `render.yaml` from the repository root.
3. Enter values for `BORCELLE_ADMIN_LOGIN` and `BORCELLE_ADMIN_PASSWORD` when prompted, then deploy.

The Blueprint creates a Node web service and PostgreSQL database, builds the site, and connects the service to the database. Render generates `BORCELLE_SESSION_SECRET`. The service uses the database for menu items, bookings, and admin sessions.

The free PostgreSQL plan is for testing and may expire; free web services can also spin down after inactivity. Review [Render's free instance limitations](https://render.com/docs/free#free-postgresql) before relying on free resources for production.

## Commands

```powershell
npm run dev
npm run build
npm start
npm run lint
```
