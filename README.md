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

For production, run `npm run build` and `npm start`, with the same environment variables supplied by your hosting platform. Configuration is validated when the Node.js server starts. Schema migration is an explicit deployment step, not a side effect of processing a payment. Back up the database and use TLS for remote database connections with certificate verification enabled.

`CHURCHPAY_DOMAINS` is the explicit list of supported ChurchTools subdomains. For `example-1.church.tools`, use `example-1` and the environment suffix `EXAMPLE_1`. Dots, slashes, percent escapes, underscores and URL fragments are rejected. Credentials are never selected from arbitrary hostnames. `PAYPAL_ENV_<TENANT>` must explicitly be `sandbox` or `live`; `NODE_ENV` does not choose the payment environment.

Generate independent secrets with `openssl rand -hex 32`. Keep `.env` files, database credentials and webhook IDs out of source control. The public PayPal client ID is sent to the browser; the client secret and ChurchTools token stay on the server.

## ChurchTools fields and prices

The group needs exactly one checkbox containing the word `Bezahlt` or `Paid` (case insensitive), such as `Bezahlt?` or `Teilnahme bezahlt`. Negative names such as `Unbezahlt`, `Unpaid`, `Nicht bezahlt` and `Not paid` are excluded. Missing or ambiguous payment checkboxes produce an explicit configuration error. The amount must be in exactly one group field named `Betrag`, `Preis`, `Buchung` or `Auswahl`. Members with status `active`, `requested` or `waiting` can pay.

Prices accept a plain number or a label with exactly one amount marked with `€`, `Euro` or `EUR`. For example, `Erwachsene (69 €)`, `Kind 6-12 Jahre: 35 €`, `Doppelzimmer - 90 €`, `69 Euro` and `1.234,56 €` are supported. Other digits, parentheses and label hyphens are allowed; multiple marked prices such as `Frühbucher 59 € / regulär 69 €` are rejected. Selection values are resolved against the group's option metadata before calculating a price. Missing choices, duplicate choices, negative amounts, non-finite numbers, exponent notation, sub-cent amounts, zero totals and totals above EUR 999,999.99 are rejected. Calculations and stored amounts use integer cents. A price or payment-field change after order creation requires operator review instead of silently charging a different amount.

## Payment links from ChurchTools emails

Existing ChurchTools mail templates can continue to construct `/pay/{domain}/{groupId}/{personId}` by substituting the ChurchTools subdomain, group ID and person ID. No ChurchTools login, signing secret, expiry or change to the registration/email workflow is required. This also supports people newly created through a group registration form who do not have a ChurchTools account.

ChurchPay is an external integration and cannot sign links inside ChurchTools templates. These ID-based links are not proof of identity: someone who guesses a valid combination can open its payment page and see the group title, amount and payment status. Participant names are not returned. Tenant allowlisting, canonical ID validation and shared rate limits remain in place, but do not make the links unguessable. The server obtains the amount and active membership from ChurchTools and verifies the bound PayPal order before recording payment.

## Payment verification and recovery

For accounting, the PayPal description uses `Anmeldung von {firstName} {lastName} (Person #{personId}) zu {groupName} (#{groupId})`, with all values read on the server. Only the group title is shortened to fit PayPal's 127-character limit; the participant name and both IDs are preserved. If those fixed parts alone exceed the limit, order creation fails instead of losing identity. The name is sent to PayPal, never returned in the public payment information. UUID-based `customId` and `invoiceId` still bind the order to its ledger record.

Before capture, ChurchPay checks the stored order ID, registration UUID, invoice ID, merchant ID, amount, currency and intent against PayPal's order. It checks the current ChurchTools price and unpaid state again. Only a full capture with status `COMPLETED` sets the checkbox. `PENDING` remains pending. Capture intent is persisted before the API call and the create/capture requests use stable PayPal idempotency keys.

A successful capture is persisted before updating ChurchTools. If that update fails, the user sees that payment was confirmed and synchronization is pending. Reconciliation retries the ChurchTools update without charging again. An ambiguous create request older than five hours is held for review rather than retried beyond PayPal's minimum six-hour idempotency window.

Register `https://churchpay.example/api/paypal/example-1` as the tenant's webhook endpoint and set its webhook ID in the environment. Subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED`. Webhook signatures are verified through PayPal's verification API and trigger a fresh authoritative order/capture lookup. A verified reversal notification is recorded only after matching its capture ID to the verified order. Reversed and refunded records never return to paid based on stale capture details.

Run reconciliation every minute, including when webhooks are enabled:

```sh
npm run reconcile
```

Alternatively schedule authenticated `GET /api/reconcile` with `Authorization: Bearer <CRON_SECRET>`. The endpoint processes up to 100 records per run and returns `503` for synchronization failures or payments requiring review. The CLI returns a nonzero exit code for the same conditions. Unsettled records are eligible every minute; synchronized completed/refunded/reversed records are checked every six hours as a fallback for missing notifications. Increase scheduling frequency/capacity if 100 records per run cannot meet your reconciliation latency. Give HTTP jobs enough runtime for sequential provider calls; a persistent CLI worker is suitable for larger installations.

Monitor the job result and structured events `payment_requires_review`, `churchtools_sync_failed` and `payment_reconcile_failed`. Logs contain internal payment UUIDs and event names, not credentials or full provider error bodies. Restrict operational access to the database: tenant, group/person IDs and payment references are personal data. Establish an appropriate backup and retention policy.

Full refunds and reversals clear the ChurchTools checkbox. Partial refunds and unexpected capture states require manual review and do not guess a replacement checkbox state. Refunded, reversed and review records do not start another payment. Voided or expired orders also require operator review; this version deliberately does not automatically replace an order that could still represent an outstanding payment. Before resolving a review record, verify its PayPal transaction history and ChurchTools membership. Preserve the original record for reconciliation and accounting; do not delete it to bypass duplicate-payment protection.

Rate limits are persisted in PostgreSQL and shared across app instances. Apply ingress request limits at the hosting platform as well. Do not log full payment URLs or query strings: they identify a registration. The application sends a restrictive referrer policy and excludes payment pages from indexing.

## Upgrading from 0.3

1. Set up PostgreSQL, configure the tenant allowlist and all required per-tenant settings, and run the migration.
2. Configure the correct sandbox or live environment explicitly. The old `USE_SANDBOX` variable is no longer used. Numeric tenant suffixes now preserve digits.
3. Keep existing ID-based confirmation-email links. Confirm that the ChurchTools version supports `GET /groups/{groupId}/members/{personId}`.
4. Set up verified PayPal webhooks and scheduled reconciliation. Exercise the full flow in the sandbox before switching live credentials.
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
