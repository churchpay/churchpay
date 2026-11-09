import assert from "node:assert/strict";
import { test } from "node:test";
import {
  domainSchema,
  getTenant,
  idSchema,
  referenceSchema,
  validateConfiguration,
} from "../lib/config";

const reference = { domain: "demo-1", groupId: "10", personId: "20" };
test("ChurchTools template links need only tenant, group and person IDs", () => {
  const url = new URL("https://churchpay.example/pay/demo-1/10/20");
  const [, , domain, groupId, personId] = url.pathname.split("/");
  assert.deepEqual(
    referenceSchema.parse({ domain, groupId, personId }),
    reference,
  );
});

function configureTenant(suffix: string) {
  for (const name of [
    "CT_TOKEN",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_MERCHANT_ID",
    "PAYPAL_WEBHOOK_ID",
  ])
    process.env[`${name}_${suffix}`] = `${name}-${suffix}`;
  process.env[`PAYPAL_ENV_${suffix}`] = "sandbox";
}

test("a broken or malformed tenant does not stop configured neighbours or expose secrets", () => {
  const original = { ...process.env };
  const originalLog = console.error;
  const logs: string[] = [];
  console.error = (value: string) => {
    logs.push(value);
  };
  try {
    process.env.DATABASE_URL = "postgresql://test@localhost/test";
    process.env.CHURCHPAY_DOMAINS = "test-healthy,test-broken,bad/tenant";
    configureTenant("TEST_HEALTHY");
    configureTenant("TEST_BROKEN");
    process.env.PAYPAL_ENV_TEST_BROKEN = "sensitive-invalid-value";
    assert.doesNotThrow(validateConfiguration);
    assert.equal(getTenant("test-healthy").environment, "sandbox");
    assert.throws(() => getTenant("test-broken"), /Invalid configuration/);
    assert(logs.some((value) => value.includes('"domain":"test-broken"')));
    assert(!logs.join().includes("sensitive-invalid-value"));
    delete process.env.DATABASE_URL;
    assert.throws(validateConfiguration);
    process.env.DATABASE_URL = "https://not-a-database.example";
    assert.throws(validateConfiguration);
  } finally {
    process.env = original;
    console.error = originalLog;
  }
});

test("legacy digit suffixes are accepted and canonical variables take precedence", () => {
  const original = { ...process.env };
  try {
    process.env.CHURCHPAY_DOMAINS = "review-gemeinde1";
    configureTenant("REVIEW_GEMEINDE_");
    assert.equal(
      getTenant("review-gemeinde1").churchToolsToken,
      "CT_TOKEN-REVIEW_GEMEINDE_",
    );
    process.env.CT_TOKEN_REVIEW_GEMEINDE1 = "new-token";
    assert.equal(getTenant("review-gemeinde1").churchToolsToken, "new-token");
    process.env.CT_TOKEN_REVIEW_GEMEINDE1 = "";
    assert.throws(() => getTenant("review-gemeinde1"));
  } finally {
    process.env = original;
  }
});

test("ambiguous legacy aliases never share credentials between tenants", () => {
  const original = { ...process.env };
  try {
    process.env.CHURCHPAY_DOMAINS = "review-gemeinde1,review-gemeinde2";
    configureTenant("REVIEW_GEMEINDE_");
    assert.throws(() => getTenant("review-gemeinde1"));
    assert.throws(() => getTenant("review-gemeinde2"));
    configureTenant("REVIEW_GEMEINDE1");
    assert.equal(
      getTenant("review-gemeinde1").churchToolsToken,
      "CT_TOKEN-REVIEW_GEMEINDE1",
    );
  } finally {
    process.env = original;
  }
});
test("reject URL, domain and path injection and non-canonical IDs", () => {
  for (const value of [
    "demo.example/org",
    "demo@evil",
    "demo%2fother",
    "DEMO",
    "demo_1",
    "demo#",
    "demo?",
    "-demo",
    "demo-",
  ])
    assert.equal(domainSchema.safeParse(value).success, false, value);
  for (const value of [
    "0",
    "01",
    "../1",
    "1/members",
    "1?x=2",
    "1.5",
    "1e2",
    "2147483648",
  ])
    assert.equal(idSchema.safeParse(value).success, false, value);
});
test("tenant allowlist and credential suffixes preserve digits", () => {
  const original = { ...process.env };
  try {
    process.env.CHURCHPAY_DOMAINS = "demo-1,demo-2";
    for (const suffix of ["DEMO_1", "DEMO_2"]) {
      for (const key of [
        "CT_TOKEN",
        "PAYPAL_CLIENT_ID",
        "PAYPAL_CLIENT_SECRET",
        "PAYPAL_MERCHANT_ID",
        "PAYPAL_WEBHOOK_ID",
      ])
        process.env[`${key}_${suffix}`] = `${key}-${suffix}`;
      process.env[`PAYPAL_ENV_${suffix}`] = "sandbox";
      delete process.env[`PAYMENT_LINK_SECRET_${suffix}`];
    }
    assert.notEqual(
      getTenant("demo-1").churchToolsToken,
      getTenant("demo-2").churchToolsToken,
    );
    assert.throws(() => getTenant("unknown"));
    delete process.env.PAYPAL_ENV_DEMO_1;
    assert.throws(() => getTenant("demo-1"));
  } finally {
    process.env = original;
  }
});
