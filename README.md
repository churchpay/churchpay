# ChurchPay

ChurchPay accepts PayPal payments for ChurchTools group registrations. It reads a member's price from ChurchTools, creates a PayPal order, and updates the group's payment checkbox only after verifying the completed capture.

Payments are recorded in PostgreSQL before external side effects. A registration has one payment record and one PayPal order. Repeated requests reuse that record, and a scheduled reconciliation job repairs interrupted captures and ChurchTools updates.

## Requirements and setup

- Node.js 24 LTS and npm.
- PostgreSQL 14 or newer, shared by every app instance. Use a direct connection or a **session** pooler. Transaction pooling is incompatible with the session advisory locks used to serialize a registration's payment.
- A dedicated ChurchTools API user with access to the relevant group membership, member fields, and permission to update its payment field.
- PayPal REST application credentials, merchant ID and a webhook registration for each tenant. Sandbox and live credentials, merchant IDs and webhook IDs are separate.

```sh
nvm use
npm ci
cp .env.example .env
# Fill in .env before starting the app.
npm run db:migrate
npm run dev
```

For production, run `npm run build` and `npm start`, with the same environment variables supplied by your hosting platform. `DATABASE_URL` is globally required and validated at startup. Invalid tenant settings are logged as `tenant_configuration_invalid` with the tenant slug, without credentials, and only that tenant's requests fail. Malformed allowlist entries are skipped and logged as `tenant_domain_invalid`; healthy tenants remain available. Schema migration is an explicit deployment step, not a side effect of processing a payment. Back up the database and use TLS for remote database connections with certificate verification enabled.

### Neon through the Vercel Marketplace

The integration supplies a transaction-pooled `DATABASE_URL` and a direct `DATABASE_URL_UNPOOLED`. **Set ChurchPay's `DATABASE_URL` to the actual value of `DATABASE_URL_UNPOOLED`** in the Vercel environment settings, then redeploy. Copy the connection string itself, not the text `$DATABASE_URL_UNPOOLED`. Its Neon hostname must not contain `-pooler`. Use that same direct URL for `npm run db:migrate`.

ChurchPay uses session advisory locks across multiple committed writes, so the Marketplace's default transaction pooler is unsuitable even if individual queries succeed. Neon explicitly lists [session advisory locks as unsupported in transaction mode](https://neon.com/docs/connect/connection-pooling). Keep certificate verification enabled; no SSL bypass is needed. Recheck this override if reconnecting the integration resets its environment variables.

`CHURCHPAY_DOMAINS` is the explicit list of supported ChurchTools subdomains. For `example-1.church.tools`, use `example-1` and the environment suffix `EXAMPLE_1`. Dots, slashes, percent escapes, underscores and URL fragments are rejected. Credentials are never selected from arbitrary hostnames. Each setting first uses the digit-preserving suffix; if absent, its old suffix (every non-letter replaced by `_`, e.g. `GEMEINDE_` for `gemeinde1`) is accepted. An explicitly empty or invalid canonical setting fails validation instead of falling back. If multiple allowed tenants share an old suffix, use canonical settings for them to avoid sharing credentials accidentally. `PAYPAL_ENV_<TENANT>` must explicitly be `sandbox` or `live`; `NODE_ENV` does not choose the payment environment.

Generate independent secrets with `openssl rand -hex 32`. Keep `.env` files, database credentials and webhook IDs out of source control. The public PayPal client ID is sent to the browser; the client secret and ChurchTools token stay on the server.

## ChurchTools fields and prices

The group needs exactly one checkbox containing the word `Bezahlt` or `Paid` (case insensitive), such as `Bezahlt?` or `Teilnahme bezahlt`. Negative names such as `Unbezahlt`, `Unpaid`, `Nicht bezahlt` and `Not paid` are excluded. Missing or ambiguous payment checkboxes produce an explicit configuration error. The amount must be in exactly one group field named `Betrag`, `Preis`, `Buchung` or `Auswahl`. Members with status `active`, `requested` or `waiting` can pay.

Prices accept a plain number or a label with exactly one amount marked with `€`, `Euro` or `EUR`. For example, `Erwachsene (69 €)`, `Kind 6-12 Jahre: 35 €`, `Doppelzimmer - 90 €`, `69 Euro` and `1.234,56 €` are supported. Other digits, parentheses and label hyphens are allowed; multiple marked prices such as `Frühbucher 59 € / regulär 69 €` are rejected. Selection values are resolved against the group's option metadata before calculating a price. Missing choices, duplicate choices, negative amounts, non-finite numbers, exponent notation, sub-cent amounts, zero totals and totals above EUR 999,999.99 are rejected. Calculations and stored amounts use integer cents. A price or payment-field change after order creation requires operator review instead of silently charging a different amount.

## Payment links from ChurchTools emails

Existing ChurchTools mail templates can continue to construct `/pay/{domain}/{groupId}/{personId}` by substituting the ChurchTools subdomain, group ID and person ID. No ChurchTools login, signing secret, expiry or change to the registration/email workflow is required. This also supports people newly created through a group registration form who do not have a ChurchTools account.

ChurchPay is an external integration and cannot sign links inside ChurchTools templates. These ID-based links are not proof of identity: someone who guesses a valid combination can open its payment page and see the group title, amount and payment status. Participant names are not returned by the payment-information endpoint; they are included in PayPal's accounting description during checkout. Tenant allowlisting, canonical ID validation and shared rate limits remain in place, but do not make the links unguessable. The server obtains the amount and eligible membership from ChurchTools and verifies the bound PayPal order before recording payment.

## Payment verification and recovery

For accounting, the PayPal description uses `Anmeldung von {firstName} {lastName} (Person #{personId}) zu {groupName} (#{groupId})`, with the name and group title read from ChurchTools on the server. Only the group title is shortened to fit PayPal's 127-character limit; the participant name and both IDs are preserved. If those fixed parts alone exceed the limit, order creation fails instead of losing identity. UUID-based `customId` and `invoiceId` still bind the order to its ledger record.

Before capture, ChurchPay checks the stored order ID, registration UUID, invoice ID, merchant ID, amount, currency and intent against PayPal's order. It checks the current ChurchTools price and unpaid state again. Only a full capture with status `COMPLETED` sets the checkbox. `PENDING` remains pending. Capture intent is persisted before the API call and the create/capture requests use stable PayPal idempotency keys.

A successful capture is persisted before updating ChurchTools. If that update fails, the user sees that payment was confirmed and synchronization is pending. Reconciliation retries the ChurchTools update without charging again. An ambiguous create request older than five hours is held for review rather than retried beyond PayPal's minimum six-hour idempotency window.

Register `https://churchpay.example/api/paypal/example-1` as the tenant's webhook endpoint and set its webhook ID in the environment. Subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED`. Webhook signatures are verified through PayPal's verification API and trigger a fresh authoritative order/capture lookup. A verified reversal notification is recorded only after matching its capture ID to the verified order. Reversed and refunded records never return to paid based on stale capture details.

### Reconciliation on Vercel Hobby

The included `vercel.json` uses **Vercel Schedules**, with `*/15 * * * *`, UTC, a 15-minute jitter window, and a `GET` path target at `/api/reconcile`. It does not use legacy `crons`, whose once-daily Hobby limit would reject a sub-daily deployment. [Schedules supports a 15-minute cadence on Hobby](https://vercel.com/docs/schedules/limits); execution may be delayed within that jitter window. This produces up to 2,976 scheduled runs in a 31-day month. Webhooks and checkout still update payment status immediately when received.

Set a random **`CRON_SECRET` of at least 32 characters** in the Vercel project before deploying. Vercel [sends it as a Bearer token to path schedules](https://vercel.com/docs/schedules/handle-runs); the endpoint rejects missing or incorrect authorization before accessing the database. Schedules is currently in beta. After deploying, verify the `payment-reconciliation` entry in the Schedules dashboard and run it once manually. Monitor its execution results; failed path runs are not automatically retried.

The 15-minute cadence leaves idle intervals for Neon to suspend, unlike a continuous one-minute poll. Actual compute usage also depends on traffic, query duration, configured compute size and suspend delay; monitor Neon usage rather than assuming a guaranteed Free-plan budget. No application keepalive is scheduled between runs.

For a different hosting platform, run the CLI **every 15 minutes**, including when webhooks are enabled:

```sh
npm run reconcile
```

The CLI and HTTP endpoint process up to 100 records per run. HTTP returns `503`, and the CLI exits nonzero, for synchronization failures or payments requiring review. Unsettled records are eligible every 15 minutes. Synchronized `completed`, `refunded` and `reversed` records are eligible every six hours **only until 30 × 24 hours after capture**; then background provider checks stop. The capture timestamp is stored once and is not extended by retries or refunds. Migration `002_payment_time.sql` conservatively uses order creation for old captured records without a provider timestamp. Unsynchronized payments remain eligible so failed ChurchTools writes can still be repaired. Verified webhooks can update older records regardless of the background cutoff.

If the queue exceeds the 100-record batch or a run approaches its 120-second function budget, monitor the backlog and increase processing capacity; changing the Hobby schedule to every minute is not supported. A persistent CLI worker is suitable for larger installations.

Monitor the job result and structured events `payment_requires_review`, `churchtools_sync_failed` and `payment_reconcile_failed`. Logs contain internal payment UUIDs and event names, not credentials or full provider error bodies. Restrict operational access to the database: tenant, group/person IDs and payment references are personal data. Establish an appropriate backup and retention policy.

Full refunds and reversals clear the ChurchTools checkbox. Partial refunds and unexpected capture states require manual review and do not guess a replacement checkbox state. Refunded, reversed and review records do not start another payment. Voided or expired orders also require operator review; this version deliberately does not automatically replace an order that could still represent an outstanding payment. Before resolving a review record, verify its PayPal transaction history and ChurchTools membership. Preserve the original record for reconciliation and accounting; do not delete it to bypass duplicate-payment protection.

Rate limits are persisted in PostgreSQL and shared across app instances. Apply ingress request limits at the hosting platform as well. Do not log full payment URLs or query strings: they identify a registration. The application sends a restrictive referrer policy and excludes payment pages from indexing.

## Upgrading from 0.3

1. Set up PostgreSQL, configure the tenant allowlist and required settings, and run `npm run db:migrate` to apply all numbered migrations, including `002_payment_time.sql`. With the Vercel/Neon integration, replace ChurchPay's `DATABASE_URL` with the value of `DATABASE_URL_UNPOOLED`.
2. Configure the correct sandbox or live environment explicitly. The old `USE_SANDBOX` variable is no longer used. Numeric tenant suffixes preserve digits, with an unambiguous fallback to the old non-letter-to-underscore suffix for existing variable names.
3. Keep existing ID-based confirmation-email links. Confirm that the ChurchTools version supports `GET /groups/{groupId}/members/{personId}`.
4. Set up verified PayPal webhooks, set `CRON_SECRET` and deploy the included 15-minute Vercel Schedule. The maintainers will verify the end-to-end PayPal sandbox flow with a real ChurchTools test group before deployment to live.
5. Reconcile any outstanding orders from the previous deployment manually. They have no record in the new payment ledger and are intentionally not accepted as new-format payments.

## Development and checks

```sh
npm run format:check
npm run lint
npm test
npm run build
npm run typecheck
npm audit --omit=dev
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the persistence and concurrent-worker integration test; otherwise that test is skipped. CI starts a PostgreSQL service and runs it automatically. Unit tests cover unsigned template links, tenant validation, malformed amounts, choice resolution, order binding, duplicate capture, pending payments, lost responses, synchronization retries, refunds and reversals. The connection smoke scripts are read-only, honor the configured PayPal environment, and return nonzero on failure:

```sh
npm run test-churchtools-client -- example-1
npm run test-paypal-client -- example-1
```

The app uses Next.js 16, React 19, Tailwind 4 and the supported PayPal Server SDK. ESLint 10 is configured with the Next.js and React Hooks plugins directly; the older React lint plugin required by `eslint-config-next` does not yet declare ESLint 10 support. TypeScript stays on 6.0 because `typescript-eslint` does not yet support the TypeScript 7 compiler API. A minimatch override selects the patched 11.x release while linter packages still request affected older majors; lint, TypeScript, tests and build are checked with that override. System fonts keep builds independent of Google Fonts availability.
