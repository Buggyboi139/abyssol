# Abyssol dashboard

A private dashboard behind a username and password for the four Abyssol games: revenue,
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

2. **Username, password, and session secret.** Run these on your machine.
   Nothing is sent anywhere, and the password is not shown as you type it.

   ```bash
   bun install
   ```

   ```bash
   bun run set-login
   ```

   ```bash
   bun run hash-password --secret
   ```

   The first asks for a username and a password and prints
   `DASHBOARD_USERNAME` and the `DASHBOARD_PASSWORD` hash. The second prints a
   `SESSION_SECRET`. With wrangler signed in (`bun x wrangler login`) and the
   Pages project made, this sets all three on the project instead of printing
   them:

   ```bash
   bun run set-login --cloudflare <project-name> --new-secret
   ```

   To change the username or password later, run it again without
   `--new-secret`, then redeploy.

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

   Or upload from your machine with no Git connection (a direct-upload
   project, which is how `abyssol` is set up). A push to GitHub then deploys
   nothing: run this after each change, and after changing any secret.

   ```bash
   bun run deploy
   ```

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
| `DASHBOARD_USERNAME` | The one username: 1 to 64 characters, no spaces, any case. Without it nobody can sign in. |
| `DASHBOARD_PASSWORD` | The hash from `bun run set-login`. It starts with `pbkdf2-sha256$`. Never the password itself: a value that is not a hash matches nothing. |
| `SESSION_SECRET` | 32 characters or more, from `bun run hash-password --secret`. Signs the session cookie. |
| `SUPABASE_URL` | The central project's URL, `https://<project-ref>.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | The central project's service role (secret) key. |
| `REVENUECAT_WEBHOOK_AUTH` | Optional. 16 characters or more. Only for the [RevenueCat webhook](#revenuecat-webhook). |

Changing `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, or `SESSION_SECRET` signs everyone out.

## GitHub Actions secrets

A source with no secret set is skipped, not failed, and its badge reads
"Not connected".

| Secret | Used by | Value |
|---|---|---|
| `SUPABASE_URL` | Both workflows | The central project's URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Both workflows | The central project's service role key. |
| `PEARL_TIDE_REVENUECAT_API_KEY` | Hourly | A RevenueCat v2 secret key for the Pearl Tide project, with read access to charts metrics. |
| `CHILLWATER_REVENUECAT_API_KEY` | Hourly | The same for Chillwater Lake. |
| `<PREFIX>_REVENUECAT_EXCLUDE` | Hourly | Optional. RevenueCat customer ids or purchase ids to leave out of every number, separated by commas: your own test purchase made in production, for example. Set it with `gh secret set` so the id is never in the repository. |
| `POSTHOG_PERSONAL_API_KEY` | Hourly | A PostHog personal API key (`phx_...`) with the `query:read` scope, scoped to every game's project. Both games are projects in one organization, so one key covers them. |
| `PEARL_TIDE_POSTHOG_PROJECT_ID` | Hourly | The PostHog project id for Pearl Tide: `767644`. |
| `CHILLWATER_POSTHOG_PROJECT_ID` | Hourly | The PostHog project id for Chillwater Lake: `768046`. |
| `<PREFIX>_POSTHOG_PERSONAL_API_KEY` | Hourly | Optional. A key for one game, for a game whose project is in another PostHog account. |
| `POSTHOG_HOST` | Hourly | Optional. `https://us.posthog.com` (the default) or `https://eu.posthog.com`. `<PREFIX>_POSTHOG_HOST` sets it for one game. |
| `PEARL_TIDE_GAME_DB_URL` | Hourly | Optional. A read-only Postgres connection string for Pearl Tide's own Supabase project. See [A read-only role](#a-read-only-role-for-a-game-database). |
| `CHILLWATER_GAME_DB_URL` | Hourly | Optional. The same for Chillwater Lake. |
| `ASC_KEY_ID` | Both | The App Store Connect API key's id. A key with the Sales and Reports role is enough for both workflows. |
| `ASC_ISSUER_ID` | Both | The App Store Connect issuer id. |
| `ASC_PRIVATE_KEY` | Both | The whole text of the key's `.p8` file. |
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
and the secret prefix. Only public identifiers belong in it. It also holds
the reporting time zone (`timezone`, one for every game), and for a game its
`genre` (which store benchmarks apply), the App Store `storefronts` whose
ratings are added up, the `search_terms` whose rank is tracked, and each
platform's `launched` date.

When a platform goes live, change its status to `live` and push. The next sync
updates the `games` table and starts pulling that platform. To rename Game 3
or Game 4, edit `display_name` and the bundle ids. Keep the slug, or the
history stays under the old one.

## Sources

| Source | Schedule | What it brings | Runs when |
|---|---|---|---|
| Store listing | Hourly | The rating and rating count by storefront, the version on sale and any waiting for review, written reviews, and the rank for each search term | iOS is live |
| RevenueCat | Hourly | Revenue, proceeds, transactions, new, active, and returning players (testers left out), conversion to paying, revenue by product, today so far and the last 24 hours | Any platform is live |
| PostHog | Hourly | DAU, WAU, sessions, new users, day 1 to day 30 retention, the first-steps funnel, the store funnel, unclean exits, errors, load time, graphics level, and a readable note on what each of the last day's players did | Any platform is live |
| Game database | Hourly | Player counts from the game's own Supabase project | Any platform is live |
| App Store Connect | Twice daily | Downloads, redownloads, updates, proceeds, impressions, page views (each also for App Store search alone), sessions, crashes | iOS is live |
| Google Play | Twice daily | Crash and ANR rates, active devices, installs, uninstalls, ratings, reviews | Android is live |

Apple's analytics reports (impressions, page views, sessions, crashes) need an
ongoing report request for the app. Only an Admin key can create one: run the
daily workflow once with **create_report_request** and an Admin key, or create
it from any Admin session. After that a key with the **Sales and Reports** role
reads everything the sync needs: sales reports (with `ASC_VENDOR_NUMBER`),
analytics reports, versions, and written reviews.

How the analytics files are read:

- A daily file is stamped with the day Apple processed it and restates the two
  or three days before it. Each day is read from the newest file that has it,
  never added up across files, and the processing day itself gets no row.
- A page view is a view of the listing (page type `Product page` or
  `Store sheet`). The report also logs every look at a screenshot or video as
  a page view (`Media view`); those are left out.
- `an_downloads_direct` is first downloads with no page: **Get** tapped in the
  search results. Page to download leaves them out, since the page never
  opened.
- Only `Counts` is read. `Unique Counts` is unique within one row of the report
  (a day, a page type, a source, a device), so adding it across rows or days
  counts a device once for every row it is in. Every store rate is a total
  over a total.
- Analytics days are UTC days. Sales report days are Pacific days. First
  downloads on the charts come from sales reports, and from analytics reports
  when no vendor number is set. The store rates (page to download, impression
  to download) use the analytics count, which covers the same days as the page
  views beside it.

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
| `POST /api/login` | Body `{"username": "...", "password": "..."}`. Sets the session cookie. A wrong username and a wrong password get the same `401`. Ten tries per caller per 15 minutes. |
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

Open `http://localhost:8788`. The local sign-in is `admin` and `abyssol-local`.
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

Days are days in the reporting time zone (`timezone` in `config/games.json`,
Pacific time, which is the day App Store Connect reports). RevenueCat and
PostHog are both counted on that clock, so a day's numbers from the two cover
the same hours. The stores post a day at a time, a day or two late, so today
and the last 24 hours come from RevenueCat and PostHog only.

A change compares the range with the same number of days before it, and shows
only when at least half of those days have data and fall after launch.

**Testers.** A RevenueCat customer is left out of every number when its
platform is not live, it was first seen before the platform's `launched` date,
its app version is not a plain release number or is newer than the version on
sale, it has a sandbox purchase, or it is named in
`<PREFIX>_REVENUECAT_EXCLUDE`. The Today panel's `ⓘ` says how many were left out.

**Info buttons.** The page shows numbers, bars, and pills. Sources, rules,
time zone and data-lag notes, tester counts, and benchmark links sit behind the
`ⓘ` button on each card, panel, and benchmark row. A click or a tap opens it;
a second one, a click elsewhere, or `Escape` closes it.

**Against the average.** A row for each of the game's own numbers beside the
average for a launch like it: the number, a bar for it on a track with a tick
at the average and a band for the usual range, and a short verdict. The row's
`ⓘ` says how the number is worked out and where the average comes from, with a
link. `config/benchmarks.json` holds every average with its source. Where a
figure exists for a game launched with no marketing, that is the average used;
where none does, the row says whose average it is.

| Row | Our number | The average |
|---|---|---|
| Downloads, first month | The first 30 days on record; before that, the daily pace × 30 | Nine unmarketed solo launches of 2026 |
| Store conversion | First downloads and redownloads ÷ impressions | Apple's peer percentiles when they are on record (those count each device once), else AppTweak's Games average |
| Page to download | First downloads made from the page (those from **Get** in the search results left out) ÷ page views | AppTweak, by genre |
| Search clicks | Page views from search ÷ impressions in search | AppFollow's category medians |
| Returning players, day 1, 7, 30 | The share of new players who came back N days later | GameAnalytics' yearly report |
| Session length, playtime | Seconds a session and seconds a player a day | GameAnalytics' yearly report |
| Paying players | Of the players whose seventh day fell in the range, the share who bought within their 7 days (RevenueCat) | Published indie figures |
| Proceeds per payer | The range's proceeds ÷ the different players who bought in it, each counted once (RevenueCat); shown once Apple's peer percentiles are on record | Apple's peer percentiles |
| Revenue, first month | RevenueCat revenue in the first 30 days | Six unmarketed launches of 2026 |

A row with no number yet says what it is waiting for.

**Numbers read by hand.** A tool with no sync of its own can still fill a row.
GameAnalytics has no key in this project, so its figures are read in the browser
and kept as one private row in `game_facts` (key `manual.gameanalytics`), never
in this repository. Retention, session length, playtime and the first-session
funnel use it until PostHog has cohorts of its own, and say when it was read.
To refresh it, upsert the row with the same shape:

```json
{ "source": "GameAnalytics", "read_at": "YYYY-MM-DD",
  "retention": { "d1": { "back": 0, "size": 0, "cohorts": "the cohort days" }, "note": "optional" },
  "session": { "secs": 0, "sessions": 0, "per_player_day_secs": 0, "player_days": 0, "note": "optional" },
  "ftue": [{ "key": "01_Step", "players": 0 }] }
```

Apple's peer percentiles (App Store Connect, Analytics, Benchmarks) come from a
signed-in console too, so they are kept the same way, as `manual.apple_peers`:

```json
{ "week": "the week of ...", "group": "the peer group",
  "store_conversion": { "p25": 0, "p50": 0, "p75": 0 },
  "proceeds_per_payer": { "p25": 0, "p50": 0, "p75": 0 } }
```

| KPI | Rule |
|---|---|
| Revenue | The sum of RevenueCat's revenue. Proceeds and transactions sit under it. |
| Installs | App Store first-time downloads plus Google Play installs. Before those arrive: RevenueCat new customers (every install makes one), then PostHog new users. The card names its source. |
| DAU | The average over whole days of each day's active players: the larger of PostHog's count and RevenueCat's customers last seen that day. The change is against the same tester-free counts for the period before, or is left blank. |
| D1 / D7 retention | Of the players who first played N days before each day in the range, the share who played again on day N. |
| Unclean exit / crash rate | Unclean exits over sessions (PostHog). Crash rate: App Store crashes over sessions, or Google Play's user-perceived crash rate. |
| Conversion rate | Of the players whose seventh day fell in the range, the share who bought within their first 7 days (RevenueCat). A player not yet 7 days old is left out. A game with nobody 7 days old shows everyone who has bought over everyone who has played. |

The sync stores each figure as a row in `metrics_daily` (`game_slug`,
`platform`, `date`, `source`, `metric_key`, `metric_value`), so a rerun
overwrites and never doubles. `sync_runs` keeps what each pull did, and the
Source sync health badges show the exact time of the last successful pull.

## Security

- The username and password are checked on the server, the password against
  a PBKDF2-SHA256 hash. The session cookie is signed (HMAC-SHA256) and set `HttpOnly; Secure;
  SameSite=Lax` with the `__Host-` prefix.
- The page holds no key. It only calls `/api`, and the Functions read the
  central database with the service role key.
- Every table has row level security on with no policies, so the anon key
  reads nothing.
- Keys live in Cloudflare Pages secrets and GitHub Actions secrets. `.env`,
  `.dev.vars`, `*.p8`, and service account files are ignored by git.
- On Cloudflare's free plan, a Function gets about 10 ms of CPU. If sign-in
  fails with error 1102, make the hash again with fewer rounds:
  `bun run set-login --iterations 50000`.
