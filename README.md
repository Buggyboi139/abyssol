# Abyssol dashboard

A private, password-protected dashboard for the four Abyssol games: revenue,
installs, players, retention, stability, and conversion, a tab a game.

- **Page:** a Vite and Chart.js single-page app, served by Cloudflare Pages.
- **API and sign-in:** Cloudflare Pages Functions in `functions/api/`. The
  password and every key stay on the server.
- **Data:** one central Supabase Postgres project (`supabase/migrations/`).
- **Sync:** scripts in `sync/`, run by GitHub Actions on a schedule, pull from
  RevenueCat, PostHog, App Store Connect, Google Play, and each game's own
  database into the central one.

A game or platform that is not live shows a `Pre-launch` or `In review` badge
and "No live data yet". Its sync is skipped, and the skip is recorded.

## Turn it on

1. **Central database.** Create a Supabase project. In its SQL editor, run the
   two files in `supabase/migrations/` in order. Or, from this folder:

   ```bash
   bunx supabase db push --db-url "postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres"
   ```

   Copy the project URL and the service role key (Project Settings, API keys).

2. **Password and session secret.** Run these on your machine. Nothing is sent
   anywhere, and the password is not echoed.

   ```bash
   bun install
   ```

   ```bash
   bun run hash-password
   ```

   ```bash
   bun run hash-password --secret
   ```

   The first prints the `DASHBOARD_PASSWORD` hash. The second prints a
   `SESSION_SECRET`.

3. **Cloudflare Pages.** In Workers & Pages, create a Pages project connected
   to this repository:

   | Setting | Value |
   |---|---|
   | Production branch | `main` |
   | Framework preset | None |
   | Build command | `bun run build` |
   | Build output directory | `dist` |

   Add the variables in [Cloudflare Pages variables](#cloudflare-pages-variables)
   as **Secrets**, then deploy again so they take effect.

4. **GitHub Actions.** In the repository's Settings, Secrets and variables,
   Actions, add the secrets in [GitHub Actions secrets](#github-actions-secrets).
   Run **Sync hourly** and **Sync daily** once by hand from the Actions tab.

5. **Domain.** In the Pages project, Custom domains, add your domain. If the
   domain's DNS is at Cloudflare, Pages adds the record. If it's elsewhere,
   add a `CNAME` for a subdomain that points to `<project>.pages.dev`. An apex
   domain needs Cloudflare DNS. If the domain pointed at GitHub Pages before,
   turn GitHub Pages off in this repository's Settings, Pages.

## Cloudflare Pages variables

Set these in the Pages project (Settings, Variables and Secrets), type
**Secret**, for Production. Add them to Preview too if you use preview builds.

| Name | Value |
|---|---|
| `DASHBOARD_PASSWORD` | The hash from `bun run hash-password`. It starts with `pbkdf2-sha256$`. Never the password itself: a value that is not a hash matches nothing. |
| `SESSION_SECRET` | 32 characters or more, from `bun run hash-password --secret`. Signs the session cookie. |
| `SUPABASE_URL` | The central project's URL, `https://<project-ref>.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | The central project's service role (secret) key. |
| `REVENUECAT_WEBHOOK_AUTH` | Optional. 16 characters or more. Only for the [RevenueCat webhook](#revenuecat-webhook). |

Changing `DASHBOARD_PASSWORD` or `SESSION_SECRET` signs everyone out.

## GitHub Actions secrets

A source with no secret set is skipped, not failed, and its badge reads
"Not connected".

| Secret | Used by | Value |
|---|---|---|
| `SUPABASE_URL` | Both workflows | The central project's URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Both workflows | The central project's service role key. |
| `PEARL_TIDE_REVENUECAT_API_KEY` | Hourly | A RevenueCat v2 secret key for the Pearl Tide project, with read access to charts metrics. |
| `CHILLWATER_REVENUECAT_API_KEY` | Hourly | The same for Chillwater Lake. |
| `PEARL_TIDE_POSTHOG_PROJECT_ID` | Hourly | The PostHog project id for Pearl Tide. |
| `PEARL_TIDE_POSTHOG_PERSONAL_API_KEY` | Hourly | A personal API key (`phx_...`) from Pearl Tide's PostHog account, with the `query:read` scope. |
| `CHILLWATER_POSTHOG_PROJECT_ID` | Hourly | The PostHog project id for Chillwater Lake. |
| `CHILLWATER_POSTHOG_PERSONAL_API_KEY` | Hourly | The same from Chillwater Lake's PostHog account. |
| `POSTHOG_PERSONAL_API_KEY` | Hourly | Optional. One key for every game, used where a game has none of its own. PostHog's free plan gives an organization one project, so each game is in its own account and needs its own key. |
| `POSTHOG_HOST` | Hourly | Optional. `https://us.posthog.com` (the default) or `https://eu.posthog.com`. `<PREFIX>_POSTHOG_HOST` sets it for one game. |
| `PEARL_TIDE_GAME_DB_URL` | Hourly | Optional. A read-only Postgres connection string for Pearl Tide's own Supabase project. See [A read-only role](#a-read-only-role-for-a-game-database). |
| `CHILLWATER_GAME_DB_URL` | Hourly | Optional. The same for Chillwater Lake. |
| `ASC_KEY_ID` | Daily | The App Store Connect API key's id. |
| `ASC_ISSUER_ID` | Daily | The App Store Connect issuer id. |
| `ASC_PRIVATE_KEY` | Daily | The whole text of the key's `.p8` file. |
| `ASC_VENDOR_NUMBER` | Daily | Your vendor number (App Store Connect, Payments and Financial Reports). Needed for sales reports. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Daily | The service account's key file, as JSON. Invite the account in Play Console with "View app information and download bulk reports". |
| `GOOGLE_PLAY_BUCKET` | Daily | The `pubsite_prod_...` bucket name (Play Console, Download reports, Statistics, Copy Cloud Storage URI). Needed for installs and ratings. |

Games 3 and 4 read `GAME3_*` and `GAME4_*` secrets of the same names
(`GAME3_REVENUECAT_API_KEY`, `GAME3_POSTHOG_PROJECT_ID`, `GAME3_GAME_DB_URL`).
The workflows already pass them. `<PREFIX>_REVENUECAT_PROJECT_ID` is optional
for any game: without it, the key's first project is used. To give one game
its own Apple, Google, or PostHog account, add the secret with the game's
prefix (for example `CHILLWATER_ASC_KEY_ID`) and pass it in the workflow.

## Games and when one goes live

`config/games.json` lists the games in tab order: slug, name, bundle ids, the
status of the game and of each platform (`live`, `in_review`, or `prelaunch`),
and the secret prefix. Only public identifiers belong in it.

When a platform goes live, change its status to `live` and push. The next sync
updates the `games` table and starts pulling that platform. To rename Game 3
or Game 4, edit `display_name` and the bundle ids. Keep the slug, or the
history stays under the old one.

## Sources

| Source | Schedule | What it brings | Runs when |
|---|---|---|---|
| RevenueCat | Hourly | Revenue, proceeds, transactions, new and active customers, conversion to paying, revenue by product | Any platform is live |
| PostHog | Hourly | DAU, WAU, sessions, new users, day 1 to day 30 retention, the first-steps funnel, the store funnel, unclean exits, errors, graphics level | Any platform is live |
| Game database | Hourly | Player counts from the game's own Supabase project | Any platform is live |
| App Store Connect | Twice daily | Downloads, redownloads, updates, proceeds, impressions, page views, sessions, crashes | iOS is live |
| Google Play | Twice daily | Crash and ANR rates, active devices, installs, uninstalls, ratings, reviews | Android is live |

Apple's analytics reports (impressions, page views, sessions, crashes) need an
ongoing report request for the app, which only a key with the **Admin** role
can create. Run **Sync daily** once with **create_report_request** ticked.
Apple fills the first report a day or two later. Sales reports work with a
Sales, Finance, or Admin key.

### PostHog events

The dashboard reads the event names the games already use for analytics. Send
them to PostHog with these names and one property:

| Event | Example | Feeds |
|---|---|---|
| `FTUE:<NN_step>` | `FTUE:01_Loaded`, `FTUE:02_Swam` | First-time funnel, in the steps' numbered order |
| `Load:Ready` | | Launches: the session count where the SDK sends no session id |
| `Store:<Step>:<product>` | `Store:Tap:pearls.pouch`, `Store:Sheet:...`, `Store:Bought:...`, `Store:Cancel:...` | Store funnel. `Buy` counts as `Tap` and `Fail` as `Error`. |
| `Session:UncleanExit:<where>` | `Session:UncleanExit:Playing` | Unclean exit rate |
| `App:Error` | | Error count |
| `Gfx:Level:<1-6>` | `Gfx:Level:3` | Graphics level |

Every event carries a `platform` property of `ios` or `android`. Without it,
PostHog's own `$os` is used. A player counts as new on the day of their first
event.

### A read-only role for a game database

In the game's own Supabase project (not the central one), in the SQL editor:

```sql
create role abyssol_reader login password '<a long random password>';
grant usage on schema runway to abyssol_reader;
grant select on all tables in schema runway to abyssol_reader;
-- Only if the tables have row level security on:
alter role abyssol_reader bypassrls;
```

Use the schema the game's queries in `config/games.json` read (`runway` for
Pearl Tide, `boards` for Chillwater Lake). The connection string is the
session pooler's, with the role's name before the project ref:

```text
postgresql://abyssol_reader.<project-ref>:<password>@<pooler-host>:5432/postgres
```

### RevenueCat webhook

Optional. With it, a sale shows within seconds instead of at the next hourly
pull. In RevenueCat (Project settings, Integrations, Webhooks), set:

- **URL:** `https://<your-domain>/api/webhooks/revenuecat?game=pearl-tide`
- **Authorization header:** the same text as `REVENUECAT_WEBHOOK_AUTH`

Only production purchases count. The hourly pull stays the record: it
overwrites each day with RevenueCat's own totals, so today's figure can read a
little high between a webhook sale and the next pull.

## API

Every route but the first three answers `401` without a valid session cookie.

| Route | What it does |
|---|---|
| `POST /api/login` | Body `{"password": "..."}`. Sets the session cookie. Ten tries per caller per 15 minutes. |
| `POST /api/logout` | Clears the cookie. |
| `GET /api/session` | `{"authenticated": true}` or `false`. |
| `GET /api/overview?range=7d\|30d\|90d` | Totals and a card a game. |
| `GET /api/game/:slug?range=7d\|30d\|90d&platform=all\|ios\|android` | One game's KPIs, charts, and sync health. |
| `POST /api/webhooks/revenuecat?game=:slug` | Its own secret, not the cookie. |

## Local development

Everything runs locally with made-up numbers: no accounts and no keys.

```bash
bun install
```

```bash
bun test
```

To see the dashboard, start the local database (it runs the real migrations
in PGlite, fills it from the mock APIs, and writes `.dev.vars`), then the
Pages server in a second terminal:

```bash
bun run local
```

```bash
bun run build && bun run pages
```

Open `http://localhost:8788`. The local password is `abyssol-local`.
`bun run local --force` fills the pre-launch games too, and `--empty`
fills none.

To try a sync without writing anything:

```bash
bun sync/run.mjs all --dry-run --mock
```

```bash
bun sync/run.mjs revenuecat --game pearl-tide --dry-run
```

The second reads real keys from the environment or from `.env` (copy
`.env.example`). Flags: `--game <slug>`, `--days <n>`, `--dry-run`, `--mock`,
`--force` (also pull platforms that are not live), `--strict` (exit 1 on a
source error), and `--create-report-request`.

## How the numbers are worked out

Days are UTC. A change compares the range with the same number of days before
it, and shows only when at least half of those days have data.

| KPI | Rule |
|---|---|
| Revenue | The sum of RevenueCat's revenue. Proceeds and transactions sit under it. |
| Installs | App Store first-time downloads plus Google Play installs. Before those arrive: PostHog new users, then RevenueCat new customers. The card names its source. |
| DAU | The average of PostHog's daily active users over whole days. Before PostHog: RevenueCat's active customers. |
| D1 / D7 retention | Of the players who first played N days before each day in the range, the share who played again on day N. |
| Unclean exit / crash rate | Unclean exits over sessions (PostHog). Crash rate: App Store crashes over sessions, or Google Play's user-perceived crash rate. |
| Conversion rate | New paying customers over new customers (RevenueCat). |

The sync stores each figure as a row in `metrics_daily` (`game_slug`,
`platform`, `date`, `source`, `metric_key`, `metric_value`), so a rerun
overwrites and never doubles. `sync_runs` keeps what each pull did, and the
Source sync health badges show the exact time of the last successful pull.

## Security

- The password is checked on the server against a PBKDF2-SHA256 hash. The
  session cookie is signed (HMAC-SHA256) and set `HttpOnly; Secure;
  SameSite=Lax` with the `__Host-` prefix.
- The page holds no key. It only calls `/api`, and the Functions read the
  central database with the service role key.
- Every table has row level security on with no policies, so the anon key
  reads nothing.
- Keys live in Cloudflare Pages secrets and GitHub Actions secrets. `.env`,
  `.dev.vars`, `*.p8`, and service account files are ignored by git.
- On Cloudflare's free plan, a Function gets about 10 ms of CPU. If sign-in
  fails with error 1102, make the hash again with fewer rounds:
  `bun run hash-password --iterations 50000`.
