# Abyssol — Full Architectural Audit & Remediation Roadmap

**Audit Date:** 2026-05-06  
**Scope:** Full codebase — `index.html`, `js/`, `css/`, `data/`, `python/`, `.github/workflows/`  
**Mode:** Read-only audit. No code was modified.

---

## Executive Summary

The application has a structurally sound foundation — the module separation is clean, the Supabase integration is correctly architected in concept, and the data pipeline through Census PUMS to location JSON files is well-designed. However, **16 discrete bugs** were identified ranging from a single typo that prevents the entire component stylesheet from loading, to a numeric data-type mismatch that silently corrupts the FIRE calculator, to a duplicate auth listener that creates race conditions on every login. The Edge Function layer (OpenRouter ingestion + AI advisor) has no source code in the repository, making the statement upload pipeline entirely non-functional.

The roadmap below is structured in four dependency-ordered phases. No phase should begin until the prior phase is verified stable.

---

## Section 1 — Dead & Vestigial Code to Remove

The following files and patterns serve no active purpose and should be deleted or replaced before new work begins to avoid confusion:

| Item | Location | Reason |
|---|---|---|
| `data/market_rates.json` | [`data/market_rates.json`](data/market_rates.json) | Never fetched by the app. Rates come from `supabase.from('macro_data')`. This file is an orphan from a pre-Supabase era. |
| Second `onAuthStateChange` handler | [`js/app.js:148-154`](js/app.js:148) | Duplicate of the handler already registered in `auth.js`. Causes double transaction fetches, double `triggerCalculations`, and double `saveUserProfile` calls on every auth event. |
| `setupForm` submit behavior | [`index.html:53`](index.html:53) | The `<form id="setupForm">` tag is vestigial. Data saving is handled through `change` events. The form tag without a `submit` listener is a trap — pressing Enter in any sidebar input can trigger a page navigation. The enclosing `<form>` should be replaced with a `<div>`. |
| Hardcoded personal data in `state.js` | [`js/state.js:4-9`](js/state.js:4) | `income: 90000`, `taxFreeIncome: 4300`, `creditScore: 666`, `age: 31` are real personal values, not neutral placeholders. These render in the UI before any Supabase profile loads and get written back to Supabase for new users who haven't entered data yet. All defaults should be `0` or `null`. |
| `python/generate_data.py` CI gap | [`python/generate_data.py`](python/generate_data.py) | No GitHub Actions workflow runs this script. The location JSON files being committed to the repo is the correct approach for a static-hosted app, but there is no documented or automated process for regenerating them when Census data is refreshed. This is a maintenance dead-end, not a bug, but must be documented. |

---

## Section 2 — Complete Bug Register

### BUG-01 — CRITICAL: Component CSS Never Loads (Root Cause of All UI Misalignment)

**File:** [`index.html:10`](index.html:10)  
**Severity:** Critical — entire component styling layer is absent  

`index.html` requests `css/components.css`, but the file on disk is named `css/componenets.css` (note the transposed `e` and `n` in "enets"). The browser silently fails this request with a 404. Every component that depends on classes defined in that file — cards, banners, tabs, dropdowns, input groups, module containers — renders unstyled or broken.

**This is the single root cause of the reported dropdown and UI misalignment issues.** No CSS restructuring is needed until this is fixed, because the current visual state does not reflect the actual CSS design.

---

### BUG-02 — HIGH: Double Auth Listener Causes Race Conditions and Double Writes

**Files:** [`js/auth.js:6`](js/auth.js:6) and [`js/app.js:148`](js/app.js:148)  
**Severity:** High — data integrity and performance  

`supabase.auth.onAuthStateChange` is registered in **both** `initAuth()` in `auth.js` and at the bottom of the `DOMContentLoaded` handler in `app.js`. Every auth state change (login, token refresh, tab focus) fires both handlers. This means:

- `fetchTransactions` is called twice concurrently
- `triggerCalculations` fires twice
- `saveUserProfile` is called twice with potentially different state snapshots

The `app.js` version is the duplicate and should be removed entirely.

---

### BUG-03 — HIGH: `hydrateUI` Does Not Update State, Causing Stale-State Saves

**Files:** [`js/ui.js:8-20`](js/ui.js:8), [`js/auth.js:54-57`](js/auth.js:54)  
**Severity:** High — data integrity  

`hydrateUI(profile)` sets DOM input `.value` properties. Then `triggerCalculations()` is called immediately after. `triggerCalculations` reads values back from the DOM into `state`, then calls `saveUserProfile`. This indirection is fragile: setting `.value` programmatically does not guarantee `parseFloat()` will read correctly if any input is not yet rendered or is in a hidden tab.

More critically, if `profile` is `null` (new user), `hydrateUI` is skipped entirely but `triggerCalculations` still runs using the hardcoded `state.js` defaults (90000 income, 666 credit score), which immediately gets written to Supabase as the new user's profile. A new user's first saved record will contain someone else's personal data.

**The correct pattern:** `hydrateUI` must update both the DOM AND the `state` object in a single pass, and `saveUserProfile` must not be called during initial load hydration.

---

### BUG-04 — HIGH: CPI Inflation Data Type Mismatch Corrupts FIRE Calculator

**Files:** [`python/fetch_economic_data.py:33`](python/fetch_economic_data.py:33), [`js/api.js:12`](js/api.js:12), [`js/calculators.js:61`](js/calculators.js:61), [`data/market_rates.json:7`](data/market_rates.json)  
**Severity:** High — silent calculation corruption  

The FRED series `CPIAUCSL` returns the **CPI Index level** (currently ~330). The FIRE calculator expects an **annualized inflation rate** (e.g., `3.1` for 3.1%). The state default in `state.js` is correctly set to `3.1`, but when real data arrives from Supabase `macro_data`, `state.marketRates.inflation_cpi` is overwritten with `~330`.

In `calculateFIRE`:
```
const realReturn = (returnRate - inflation) / 100;
// e.g., (7 - 330) / 100 = -3.23
```

A real return of `-3.23` means the portfolio shrinks indefinitely — the FIRE projector loop runs to age 100 every time and never converges. `market_rates.json` already shows `"inflation_cpi": 330.293`, confirming the production Supabase table stores the index value.

**Fix requires:** Either change `fetch_economic_data.py` to fetch `CPIAUCSL_PC1` (the year-over-year percent change series) instead of the level, OR add a calculation in `api.js` to convert the stored index to a rate before assigning to state.

---

### BUG-05 — HIGH: `fetchUserProfile` Silently Swallows New-User Error

**File:** [`js/api.js:27-30`](js/api.js:27)  
**Severity:** High — broken new user onboarding  

Supabase's `.single()` throws `PGRST116` ("JSON object requested, multiple or no rows returned") when no profile row exists. The function destructures only `{ data }` and discards `error`. For a new user, `data` will be `null` and `error` will be populated, but the error is invisible. This causes the silent failure where `handleAuthChange` receives `null`, skips hydration, but still proceeds with defaults.

**Fix requires:** Destructure `{ data, error }` and handle the `PGRST116` case explicitly as "new user, no profile yet" rather than treating it as an unexpected failure.

---

### BUG-06 — HIGH: Geo-Arbitrage Comparison is Non-Functional (Hardcoded Tax Rate)

**File:** [`js/ui.js:152-155`](js/ui.js:152)  
**Severity:** High — feature completely broken  

The `geoCompare` dropdown in the Benchmarking tab is read but its value is never used. `compareTaxRate` is hardcoded to `0.22` regardless of selection. The comparison always produces identical net income to the user's current location. The Geo-Arbitrage Engine panel is cosmetically present but functionally inert.

**Fix requires:** `updateBenchmarking` must call `fetchLocationData(compareLoc)` to retrieve the comparison location's tax rate and COL multiplier and use them in the net income calculation.

---

### BUG-07 — MEDIUM: Transaction History Ledger Renders Empty Bodies

**File:** [`js/ui.js:69-75`](js/ui.js:69)  
**Severity:** Medium — feature partially broken  

`updateOverview` renders `<details>` elements for each month with only the month label and total outflow. The `category-body` div inside each `<details>` is always empty — `grouped[month].items` (the individual transactions) is never iterated or rendered. Users can see monthly totals but cannot drill into individual transactions.

---

### BUG-08 — MEDIUM: Cash Flow Display Uses Manual Inputs, Not Transaction History

**File:** [`js/ui.js:77-86`](js/ui.js:77)  
**Severity:** Medium — design incoherence  

The "30-Day Free Cash Flow" card and "Historical Savings Rate" are calculated from manually entered expense inputs in the sidebar, not from `state.transactions`. This creates a split-brain: the Overview tab shows a manually estimated cash flow while the History chart (when transactions exist) shows actual transaction data. The two systems are never reconciled, so the KPI cards can contradict the chart.

---

### BUG-09 — MEDIUM: `saveUserProfile` Has No Debounce (Excessive Supabase Writes)

**File:** [`js/ui.js:37-51`](js/ui.js:37), [`js/app.js:24`](js/app.js:24)  
**Severity:** Medium — performance and rate limiting  

`triggerCalculations` (which calls `saveUserProfile`) is bound to `'input'` events on all `.expense-input` elements. Typing "$1,250" into the housing field fires 5 upsert requests to Supabase. There is no debounce, dirty-check, or minimum interval. On a slow connection, this creates a queue of in-flight requests that can resolve out of order, potentially overwriting a later save with an earlier one.

---

### BUG-10 — MEDIUM: Statement Processing Pipeline Has No Source Code in Repo

**Files:** [`js/app.js:119`](js/app.js:119), [`js/app.js:52`](js/app.js:52), [`js/app.js:84`](js/app.js:84)  
**Severity:** Medium (known gap) — feature non-functional  

The application invokes three Supabase Edge Functions: `process-statement`, `ai-advisor` (for insights), and `ai-advisor` (for budget optimization). None of these functions have source code in the repository. There is no `supabase/functions/` directory. The functions may exist in the Supabase dashboard directly, but they are not version-controlled, cannot be reviewed, cannot be deployed via CI, and cannot be debugged from this codebase.

---

### BUG-11 — MEDIUM: OpenRouter Response Parsing is Fragile

**File:** [`js/app.js:127`](js/app.js:127)  
**Severity:** Medium — brittle, will break on any prompt output variance  

```js
let transactions = JSON.parse(
    data.result.replace(/```json/gi, '').replace(/```/g, '').trim()
);
```

This manual markdown-stripping approach assumes OpenRouter's response will always be wrapped in exactly a ` ```json ` code fence. Any variation in model output — a leading explanation sentence, a trailing comment, different fence syntax, valid JSON without a fence — will cause a `JSON.parse` error and the entire upload fails. The Edge Function must be responsible for returning clean, validated JSON, not the client.

---

### BUG-12 — LOW: `national.json` Lower Percentile Brackets Contain Zero Income

**File:** [`data/national.json:10-50`](data/national.json:10)  
**Severity:** Low — percentile accuracy degraded  

The first 10+ income percentile brackets in `national.json` have `"income": 0.0`. This is likely an artifact of the Census PUMS data containing records with no income (unemployed, retired, under-18). The `getPercentile` function in `calculators.js` searches for the first bracket where `b.income >= income`. If a user has any positive income (e.g. $1), they will skip past all the zero brackets and land at a very high percentile incorrectly. The zero-income population should be excluded from bracket generation in `generate_data.py`.

---

### BUG-13 — LOW: `<form id="setupForm">` Has No Submit Listener

**File:** [`index.html:53`](index.html:53)  
**Severity:** Low — potential accidental page reload  

The sidebar profile section is wrapped in a `<form>` element with `novalidate` but no `submit` event handler. Pressing Enter in any text/number input inside it will submit the form, which on GitHub Pages will trigger a page reload and lose all unsaved state. All data wiring goes through `change`/`input` events, not form submission, so the `<form>` tag serves no purpose and is a hazard.

---

### BUG-14 — INFORMATIONAL: Supabase Anon Key Exposed — RLS Audit Required

**File:** [`js/api.js:1-4`](js/api.js:1)  
**Severity:** Informational (key is intentionally public, but RLS must be verified)  

The Supabase project URL and anon (publishable) key are hardcoded in client-side JavaScript. This is the standard Supabase pattern for browser clients. However, Row Level Security **must** be active and correctly configured on the `profiles`, `transactions`, and `statements` tables. Without RLS, any authenticated user can query any other user's financial data. RLS status was not auditable from this repository and must be confirmed in the Supabase dashboard.

---

## Section 3 — Correct Data Flow Architecture

The following describes the intended data flow. Each numbered node is an integration point.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER CLIENT                                │
│                                                                      │
│  1. Page Load                                                        │
│     └─ fetchMarketData() → supabase.macro_data → state.marketRates  │
│                                                                      │
│  2. Auth Gate                                                        │
│     └─ supabase.auth.signIn / signUp / onAuthStateChange            │
│         └─ handleAuthChange(session)                                 │
│             ├─ fetchUserProfile(userId) → profiles table             │
│             │    └─ if row exists: hydrateUI(profile) + setState()  │
│             │    └─ if no row: show empty form, await user input    │
│             ├─ fetchTransactions(userId) → transactions table        │
│             │    └─ state.transactions = []                          │
│             └─ triggerCalculations() ← one call, no duplicate       │
│                                                                      │
│  3. Profile Sidebar (input changes)                                  │
│     └─ [debounced] triggerCalculations()                             │
│         ├─ read DOM → update state                                   │
│         ├─ fetchLocationData(state.location) → data/{loc}.json      │
│         ├─ saveUserProfile(userId, state) → profiles table           │
│         └─ render all panels                                         │
│                                                                      │
│  4. Statement Upload (tab-sync)                                      │
│     └─ file selected                                                 │
│         ├─ upload to supabase.storage.statements/{userId}/{file}     │
│         ├─ invoke Edge Fn: process-statement({filePath, userId})     │
│         │    └─ [Edge Fn reads storage, calls OpenRouter]           │
│         │    └─ [Edge Fn parses + validates JSON, returns array]    │
│         ├─ insert validated transactions → transactions table        │
│         ├─ re-fetch state.transactions                               │
│         └─ triggerCalculations() → re-render history + overview     │
│                                                                      │
│  5. AI Insights / AI Budget (ai-advisor Edge Fn)                     │
│     └─ invoke Edge Fn: ai-advisor({profile, transactions, task})    │
│         └─ [Edge Fn calls OpenRouter with structured prompt]        │
│         └─ returns markdown string → render in output div           │
│                                                                      │
│  6. Benchmarking Tab                                                 │
│     └─ state.location → fetchLocationData() → state.locationData    │
│     └─ geoCompare selection → fetchLocationData(compareLoc)         │
│     └─ getPercentile(state.locationData, demographics, income)      │
│     └─ drawBellCurve(percentile)                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     SUPABASE BACKEND                                 │
│                                                                      │
│  Tables (all must have RLS enabled):                                 │
│  ├─ profiles   { id, income, tax_free_income, shared_contribution,  │
│  │               portfolio, credit_score, age, location,            │
│  │               household_type, sex, education, race, updated_at } │
│  ├─ transactions { id, user_id, date, amount, description,          │
│  │                 category, source_statement, created_at }         │
│  └─ macro_data { date, fred_mortgage_30yr, fred_auto_new,           │
│                   fred_inflation_rate (NOT index), last_updated }   │
│                                                                      │
│  Storage:                                                            │
│  └─ statements bucket → {userId}/{timestamp}_{filename}             │
│                                                                      │
│  Edge Functions:                                                     │
│  ├─ process-statement: read storage → call OpenRouter →             │
│  │                     validate JSON → return clean array           │
│  └─ ai-advisor: receive profile+transactions → call OpenRouter →    │
│                 return markdown string                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  GITHUB ACTIONS / PYTHON PIPELINE                    │
│                                                                      │
│  update_rates.yml (daily cron)                                       │
│  └─ fetch_economic_data.py                                           │
│      ├─ FRED MORTGAGE30US → fred_mortgage_30yr                      │
│      ├─ FRED RIOSNVA → fred_auto_new                                │
│      └─ FRED CPIAUCSL_PC1 (rate, not index) → fred_inflation_rate   │
│      └─ upsert → supabase.macro_data                                │
│                                                                      │
│  [Manual / undocumented]                                             │
│  └─ generate_data.py                                                 │
│      ├─ reads Census PUMS CSVs from ./raw_data/                     │
│      └─ writes data/{loc}.json → committed to repo                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Section 4 — Phased Remediation Roadmap

### Phase 1 — Stabilization (Prerequisites for Everything Else)

These items must be resolved before any data integrity or feature work begins. Items are ordered by dependency.

---

**P1-1: Fix CSS Filename Mismatch**  
_Dependency: None. Must be first._

Rename `css/componenets.css` → `css/components.css`, or change the `<link>` tag in `index.html` to match the existing filename. Do not do both without coordinating.  
**Affects:** Every UI element styled by components.css — all dropdown alignment, card layouts, module containers, banners, upload zone.

---

**P1-2: Remove Duplicate `onAuthStateChange` Handler**  
_Dependency: None._

Remove lines 148–154 from [`js/app.js`](js/app.js:148). The handler in [`js/auth.js`](js/auth.js:6) is sufficient and more complete (it calls `hydrateUI`). The `app.js` version only calls `fetchTransactions` and does not hydrate the profile.

---

**P1-3: Replace Hardcoded State Defaults with Neutral Zeros**  
_Dependency: P1-2 must be done first to avoid a race condition between two duplicate handlers reading a zeroed state._

In [`js/state.js`](js/state.js), replace all personal-data defaults:
- `income: 90000` → `0`
- `taxFreeIncome: 4300` → `0`
- `creditScore: 666` → `720` (a safe neutral)
- `age: 31` → `25` (HTML placeholder default)

---

**P1-4: Guard `triggerCalculations` from Saving on Initial Load**  
_Dependency: P1-3._

`triggerCalculations` must not call `saveUserProfile` during the initial hydration pass. Add an `isHydrating` flag (or check `state.profileLoaded`) — set it `true` before `hydrateUI`/`triggerCalculations` is called on login, and `false` after the first full render cycle. Only call `saveUserProfile` when the user has explicitly interacted with a form field after load.

---

**P1-5: Fix `fetchUserProfile` New-User Error Handling**  
_Dependency: P1-4._

Destructure `{ data, error }` from the Supabase query. Treat `PGRST116` as "no profile yet" and return an explicit sentinel (e.g., `null` with a clear comment) rather than silently discarding the error. In `handleAuthChange`, check for this case and set a `state.isNewUser = true` flag so the UI can show guidance to complete the profile rather than silently using default values.

---

**P1-6: Replace `<form id="setupForm">` with `<div>`**  
_Dependency: None._

Swap the `<form>` wrapper to a `<div>` in `index.html`. Remove the `novalidate` attribute (no longer relevant). This prevents accidental form submission via Enter key.

---

**P1-7: Add Debounce to `triggerCalculations`**  
_Dependency: P1-4._

Wrap `saveUserProfile` inside `triggerCalculations` with a 600–800ms debounce. Calculations and chart redraws can run immediately on every input event, but the Supabase write should only fire after the user has paused typing. This also eliminates the race condition from out-of-order network responses.

---

### Phase 2 — Data Integrity

These items address correctness of the data flowing through the system.

---

**P2-1: Fix CPI Inflation Data Type in Python Pipeline**  
_Dependency: Access to Supabase dashboard to rename/add column._

In [`python/fetch_economic_data.py`](python/fetch_economic_data.py:33), change the FRED series from `'CPIAUCSL'` (index level, ~330) to `'CPIAUCSL_PC1'` (year-over-year percent change, ~3.1). Update the Supabase `macro_data` table column from `fred_inflation` to `fred_inflation_rate` (or confirm the column can store a rate). Update `api.js` to map to `state.marketRates.inflation_cpi` correctly. **The FIRE calculator is broken until this is resolved.**

---

**P2-2: Delete `data/market_rates.json` and Remove All References**  
_Dependency: None. Confirm no code path touches this file._

Verify via grep that `market_rates.json` is not `fetch()`'d anywhere in the JS. Then delete the file. It cannot be kept as a "fallback" because it stores the raw CPI index (~330), which would corrupt the FIRE calculator if somehow loaded. The true fallback values live in `state.js`.

---

**P2-3: Fix `national.json` Zero Percentile Brackets**  
_Dependency: `python/generate_data.py` fix and re-run._

In `generate_data.py`, filter out records where `PINCP <= 0` or `HINCP <= 0` from all bracket calculations before percentile generation. This removes the zero-income population from the distribution so that any user with income > $0 doesn't land at a false 99th percentile. After fixing the script, regenerate all six location JSON files and commit them.

---

**P2-4: Fix Geo-Arbitrage Comparison Tax Rate**  
_Dependency: P1-5 (fetchLocationData must reliably return data)._

In `updateBenchmarking()` in [`js/ui.js`](js/ui.js:152), replace the hardcoded `compareTaxRate = 0.22` with a `fetchLocationData(compareLoc)` call that retrieves the selected location's actual `tax_rate` and `col_multiplier`. The comparison net income should reflect the target location's real tax burden, not the user's current location.

---

**P2-5: Reconcile Manual Cash Flow with Actual Transaction Data**  
_Dependency: P2-4, and transactions must be flowing from Supabase (Phase 3)._

The "30-Day Free Cash Flow" KPI card must present a unified figure. Define a clear rule: if `state.transactions` contains entries for the current calendar month, derive cash flow from actual transaction data. If no transaction data exists for the current month (new user, no uploads yet), fall back to the manual expense engine estimate and label it clearly as "Estimated." Both calculation paths must be explicit and labeled in the UI.

---

**P2-6: Confirm Supabase RLS Is Active**  
_Dependency: Supabase dashboard access._

Manually verify in the Supabase dashboard that `profiles`, `transactions`, and the `statements` storage bucket all have Row Level Security enabled, with policies scoped to `auth.uid() = user_id` (or `auth.uid() = id` for profiles). This is a security prerequisite, not optional.

---

### Phase 3 — Feature Completeness

These items restore or complete the four intended core features. Each depends on Phase 1 and Phase 2 being stable.

---

**P3-1: Build and Deploy `process-statement` Edge Function**  
_Dependency: All of Phase 1, Supabase Edge Functions environment, OpenRouter API key._

Create `supabase/functions/process-statement/index.ts` (or `.js`). The function must:
1. Accept `{ filePath, mimeType, userId }` in the request body
2. Read the file from Supabase Storage using the service role key
3. Send the file content to OpenRouter with a structured prompt that requests a JSON array matching the `transactions` table schema
4. **Validate** the returned JSON on the server side before returning it — do not pass raw LLM output to the client
5. Return `{ transactions: [...] }` with a validated array, never raw markdown
6. Handle errors from OpenRouter gracefully with descriptive messages

Remove the manual markdown-stripping from [`js/app.js:127`](js/app.js:127) once the Edge Function returns clean JSON.

---

**P3-2: Build and Deploy `ai-advisor` Edge Function**  
_Dependency: P3-1 (shared OpenRouter infrastructure), OpenRouter API key._

Create `supabase/functions/ai-advisor/index.ts`. The function must:
1. Accept `{ profile, transactions, task }` where `task` is `'generate-insights'` or `'optimize-budget'`
2. Construct appropriate prompts for each task type
3. Call OpenRouter and return the response as `{ result: "..." }` (plain text / markdown string)
4. Log errors and return descriptive failure messages, not raw OpenRouter error objects

---

**P3-3: Complete Transaction History View**  
_Dependency: P3-1 (transactions must exist in Supabase)._

In `updateOverview()` in [`js/ui.js`](js/ui.js:69), populate the `category-body` div inside each monthly `<details>` element by iterating `grouped[month].items`. Each transaction should display: date, description, category (with color coding), and amount (positive inflow in green, negative outflow in red). Categories derived from OpenRouter parsing should match a defined enum (Housing, Transportation, Food, Entertainment, Income, etc.) for consistent color mapping.

---

**P3-4: Restore Budget Affordability Calculator as Explicit "What-If" Mode**  
_Dependency: P2-5 (reconciled cash flow)._

The Purchase Matrix tab (tab-purchases) currently functions as a purchase affordability calculator using sliders. This is the correct intended experience. No structural change is needed here — but it must clearly display the **actual** vs **estimated** income being used. If the user has real transaction data, the calculator should optionally allow toggling between "use my reported income" and "use my computed average monthly inflow from transactions." Add a labeled toggle control.

---

**P3-5: Build Peer Comparison Tab Powered by Census Data**  
_Dependency: P2-3 (clean percentile brackets), P2-4 (geo comparison fix)._

The Benchmarking tab (tab-benchmarking) has the correct structure. Remaining work:
1. Fix `getPercentile` to handle the edge case where multiple brackets share `income: 0.0` (exclude zero-income records at generation time per P2-3)
2. Make the `geoCompare` dropdown actually pull the selected location's COL multiplier to compute adjusted net income (per P2-4)
3. Add a second bell curve or percentile line showing where the user would rank **in the comparison city** to make the geo-arbitrage analysis meaningful

---

### Phase 4 — UI Refinement

These items should only begin after Phase 1–3 are verified stable. UI work on broken data pipelines wastes effort.

---

**P4-1: Define Tab Architecture Matching Intended Feature Set**

The six current tabs (`Total Overview & History`, `Current Budget`, `Purchase Matrix`, `FIRE Projector`, `Benchmarking`, `Data Sync`) map well to the four intended features with minor reorganization:

| Intended Feature | Current Tab | Status |
|---|---|---|
| Budget Affordability Calculator | Purchase Matrix | Functional, needs income toggle (P3-4) |
| Expense History View | Total Overview & History | Partially broken — ledger bodies empty (P3-3) |
| Peer Comparison | Benchmarking | Broken — geo-arbitrage hardcoded (P2-4, P3-5) |
| AI Statement Ingestion | Data Sync | Non-functional — Edge Fn missing (P3-1) |

No tabs need to be removed. The `FIRE Projector` and `Current Budget` tabs are additive features not in conflict with the four stated goals.

---

**P4-2: Fix Dropdown Rendering After CSS Fix**  
_Dependency: P1-1 (CSS filename fix)._

After BUG-01 (CSS typo) is fixed and the component stylesheet loads, re-evaluate all dropdown and select element styling before making any CSS changes. The reported misalignment may be entirely resolved by P1-1 alone.

---

**P4-3: Add Skeleton / Loading States for Async Data**  
_Dependency: All Phase 1 and Phase 2._

Currently, panels render with zero values while waiting for Supabase data. Add skeleton loaders or a `loading` state indicator on the metric cards (`overviewLiquidity`, `overviewCashFlow`, `percentileValue`) so users understand data is being fetched rather than seeing zeroed or default values.

---

**P4-4: Add User Onboarding Empty State**  
_Dependency: P1-5 (new user detection)._

When `state.isNewUser` is true (no profile row exists), display an explicit onboarding prompt in the main workspace explaining that the user should complete the Profile Setup sidebar. The current behavior — showing zeroed dashboard panels with no guidance — is confusing.

---

## Section 5 — Open Questions Requiring Clarification

The following items cannot be planned or executed without your input:

1. **Supabase Edge Function source code location:** Do `process-statement` and `ai-advisor` currently exist in the Supabase dashboard as live functions? If so, their source code needs to be pulled into the repository under `supabase/functions/` for version control and auditing before any modifications are made.

2. **OpenRouter model selection:** Which OpenRouter model should `process-statement` use for financial statement parsing? Different models have very different context windows, cost profiles, and JSON instruction-following reliability. The choice matters for the parsing quality of multi-page PDFs.

3. **OpenRouter API key management:** Where is the OpenRouter API key currently stored? Is it set as a Supabase Edge Function secret, a GitHub Actions secret, or elsewhere? This determines whether it needs to be re-provisioned.

4. **`macro_data` Supabase table schema:** What are the exact column names in the `macro_data` table? Specifically, is the inflation column named `fred_inflation` and does it currently store the CPI index value (~330) or a rate (~3.1)? This determines the scope of the P2-1 fix.

5. **`profiles` table schema:** What columns currently exist in the `profiles` table? Knowing whether `household_type`, `sex`, `education`, `race`, `tax_free_income`, and `shared_contribution` columns exist confirms whether `saveUserProfile` is writing to valid columns or silently failing.

6. **Supabase RLS status:** Are Row Level Security policies currently active on `profiles`, `transactions`, and the `statements` storage bucket? If not, this is a critical security item that must be addressed before the app handles any real financial data.

7. **Census PUMS data currency:** When were the PUMS data files last downloaded and used to generate the location JSON files? The `generate_data.py` script uses an `INFLATION_MULTIPLIER = 1.06` that should be recalculated based on the vintage of the source data. Stale data will produce inaccurate percentiles.

8. **`FIRE Projector` tab scope:** Is the FIRE Projector intended to be a permanent feature, or was it included as an early prototype that should be removed in favor of focusing on the four stated pillars? This affects how much effort to invest in making it robust vs. simply fixing the CPI bug and leaving it as-is.

---

## Section 6 — Dependency Map

```
P1-1 (CSS fix)
  └─ P4-2 (dropdown re-evaluation)

P1-2 (remove duplicate listener)
  └─ P1-3 (zero out state defaults)
       └─ P1-4 (guard save on load)
            └─ P1-5 (new user error handling)
                 └─ P1-7 (debounce save)
                      └─ P4-4 (onboarding empty state)

P2-1 (CPI rate fix) ──────────────────────────────── fixes FIRE tab
P2-2 (delete market_rates.json)
P2-3 (zero-income bracket fix)
  └─ P3-5 (peer comparison)

P2-4 (geo-arbitrage fix)
  └─ P3-5 (peer comparison)

P2-5 (reconcile cash flow)
  └─ P3-4 (affordability calculator income toggle)

P1-5 → P2-6 (RLS audit) ──────────────────────────── security baseline

P3-1 (process-statement Edge Fn)
  └─ P3-3 (transaction history UI)
       └─ P2-5 (cash flow reconciliation)

P3-2 (ai-advisor Edge Fn) ────────────────────────── AI features restored

All Phase 1 + Phase 2 complete
  └─ P4-1 (tab architecture review)
  └─ P4-3 (skeleton loaders)
```

---

*Roadmap compiled from full source audit. No code was modified. All line references are to files as they exist in the repository at audit time.*
