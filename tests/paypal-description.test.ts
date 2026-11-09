import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentDescription } from "../lib/paypal";

const payment = { groupId: "123", personId: "456" };
const quote = { personName: "Anna Müller", groupName: "Sommerfreizeit" };
test("PayPal descriptions retain the accounting format", () => {
  assert.equal(
    paymentDescription(payment, quote),
    "Anmeldung von Anna Müller (Person #456) zu Sommerfreizeit (#123)",
  );
});
test("only the group name is shortened to fit 127 characters", () => {
  for (const groupName of ["Lange Freizeit ".repeat(30), "🌞".repeat(200)]) {
    const description = paymentDescription(payment, { ...quote, groupName });
    assert.equal(Array.from(description).length, 127);
    assert(
      description.startsWith("Anmeldung von Anna Müller (Person #456) zu "),
    );
    assert(description.endsWith(" (#123)"));
    assert(!description.includes("\uFFFD"));
  }
});
test("an oversized name never silently truncates participant identity", () => {
  assert.throws(
    () =>
      paymentDescription(payment, { ...quote, personName: "A".repeat(127) }),
    /name and IDs exceed/,
  );
});
