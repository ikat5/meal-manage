# Meal Manage

A dark mess management app for balances, members, deposits, meals, and groceries. Browser JavaScript, Node.js 24, and MongoDB Atlas. The runtime uses MongoDB only; SQLite is supported solely as a read-only source for importing older data.

## Run locally

```sh
npm ci
test -f .env || cp .env.example .env
npm start
```

Before starting, set these private values in `.env`:

- `MONGODB_URI`: the complete Atlas connection string, including database credentials.
- `MONGODB_DB`: `meal_manage` by default; use a dedicated database for this app.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: login credentials. Production passwords must contain 8–256 characters; choose a unique password.
- `MESS_NAME`: the name shown in the sidebar.

Open http://127.0.0.1:3000 and log in with the credentials from `.env`. A private `.env` may already be configured in the original workspace; keep it private and do not overwrite it when copying the example. No credentials are bundled with the source or exposed to the browser.

`npm run dev` restarts the server after server/module edits. Refresh the browser for frontend changes. `HOST` defaults to `127.0.0.1` locally. Production and Render always bind to `0.0.0.0`, even if a copied local `HOST` setting specifies localhost; the server uses Render's `PORT` environment variable.

## Deploy manually on Render's free tier

The repository includes [render.yaml](render.yaml) for a **free Node web service** in Singapore, with automatic deployment disabled and no paid disk or Render database.

1. Push this repository to your GitHub account and connect that repository to Render.
2. In Render, create a **Blueprint** from the repository. It reads `render.yaml`. Choose the free instance if prompted.
3. Supply `MONGODB_URI` from your private Atlas environment file and choose `ADMIN_PASSWORD` (8–256 characters). The username defaults to `admin`; change `MESS_NAME` as desired.
4. In Atlas Network Access, allow the outbound IP ranges shown for the Render service. The Atlas database user needs read/write access to the configured database. Keep the database name consistent with your import and local configuration.
5. Deploy manually. Wait for `/healthz` to return `{"status":"ok"}` and open the Render service URL.

For a manually configured **Web Service** instead of a Blueprint, use:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Instance | Free |
| Build command | `npm ci --omit=dev && npm run check` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Node version | `24.21.0` |
| Environment | `NODE_ENV=production`, `HOST=0.0.0.0`, `SECURE_COOKIE=true`, plus the database/admin settings above |

HTTP starts while Atlas connects, allowing Render to detect the port immediately. `/healthz` returns `503` until Atlas initialization completes, then checks database connectivity before returning `200`. Data requests return `503` while initialization is pending or failed. An initial connection failure is logged separately; correct the database settings and restart the service. Production startup rejects missing or short passwords. HTTPS cookies are enabled in the Blueprint. Data lives in Atlas, so Render restarts do not erase records. Sessions are process-local and restarting/redeploying signs users out; this configuration uses one instance. Render free services may sleep when idle; availability and limits follow Render's current free-tier terms.

If Render reports **port scan timeout / no open ports**, confirm the service uses `npm start` as its start command (not the build/check command) and deploy the latest commit. Look for `Meal Manage is listening on 0.0.0.0:<PORT>` in the logs. A `Database initialization failed` message or an HTTP `503` health check is a separate Atlas/configuration issue; an open port alone does not mean the database is ready. See [Render port binding](https://render.com/docs/web-services#port-binding) and [health checks](https://render.com/docs/health-checks).

For an immediate startup exit, read the `Startup failed:` message: invalid `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `PORT` settings name the exact requirement without logging their values. Update that variable in Render's Environment page, save, and deploy. Set the website login password as `ADMIN_PASSWORD`; MongoDB credentials belong in `MONGODB_URI`.

Configuration references: [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Render web services](https://render.com/docs/web-services), [Render free instances](https://render.com/docs/free).

## Import existing SQLite data

The original file remains untouched. Run the importer from a machine that can reach Atlas, using the same `.env` database settings as the deployed app:

```sh
npm run migrate:sqlite -- --source data/meal-manage.sqlite
npm run migrate:sqlite -- --source data/meal-manage.sqlite --apply
```

The first command validates a consistent read-only snapshot and prints counts. `--apply` imports it transactionally only if all target app collections are empty; a second import into populated collections is rejected. Member and record IDs, integer paisa, historical attendance, estimates, and dates are preserved. Keep the original database as a private backup until you have verified the imported records. Never commit the database or an export of it.

## Data and behavior

- `/` opens login for signed-out users. Login opens Balances; direct page URLs and back/forward navigation work.
- MongoDB stores separate members, deposits, groceries, and meals collections. Attendance is embedded in its meal. Unique meal date/slot and record-ID indexes are created at startup.
- Each mutation runs in a transaction. A shared metadata write serializes changes so reference checks, deletions, and ID allocation remain consistent across application processes. IDs increase rather than being reused. Reads use a consistent snapshot. See [MongoDB driver transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).
- Amounts are integer paisa, displayed in BDT. Actual meal rate is grocery spending divided by all portions. Member costs use the unrounded rate and reconcile rounding paisa deterministically. Balances cover all recorded data.
- Each checked member has one total-portion input with minus/plus controls, accepting 1–40. Legacy guest counts are folded into the displayed total. Uncheck anyone who did not eat.
- Approximate total meal cost and approximate cost per portion are reference values only. They never change grocery spending, actual meal rate, balances, or cash.
- Edit/delete actions use drawers and refresh totals. Members with history must be deactivated instead of deleted. Meal editing retains historical inactive participants; deleting a meal removes its embedded attendance.
- Purchase attribution does not automatically create deposits or reimbursements. With no meal portions, actual meal rate and member costs are zero while spending reduces cash.

## Checks

```sh
npm run check
npm test
```

API tests use an isolated in-memory **test double**, not production storage. Calculation tests verify financial behavior. Import tests use temporary SQLite fixtures. The real MongoDB integration test is skipped unless `MONGODB_TEST_URI` is set; when enabled, it uses and removes a uniquely named `meal_manage_test_*` database. Never point that variable at credentials without permission to create and drop test databases. Offline tests do not establish a successful live Atlas connection.

## Files

- `server.js`: HTTP routes, validation, login, and health checks.
- `storage/mongo-store.js`: Atlas persistence, transactions, indexes, and numeric IDs.
- `public/`: application UI and shared calculations.
- `scripts/migrate-sqlite.js`: guarded read-only SQLite importer.
- `tests/`: API, financial, import, and opt-in MongoDB tests.
- `render.yaml`: free-tier manual deployment configuration.

Keep `.env`, Atlas credentials, database files, and GitHub tokens out of commits.
# meal-manage
