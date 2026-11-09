import assert from "node:assert/strict";
import { test } from "node:test";
import {
  quoteFromResponse,
  resolveMemberFieldValues,
  selectField,
  selectPaidField,
} from "../lib/churchtools";
import type { GroupMemberField } from "../lib/types";

const field = (id: number, name: string, code = "text"): GroupMemberField => ({
  type: "group",
  field: { id, name, fieldTypeCode: code, options: [] },
});
test("payment checkbox supports punctuation and labels without matching negative names", () => {
  for (const name of [
    "Bezahlt?",
    "Teilnahme bezahlt",
    "Paid?",
    "Already paid",
    "BEZAHLT",
    "Gebühr: Bezahlt ✅",
  ]) {
    assert.equal(
      selectPaidField([field(1, "Unbezahlt"), field(2, name, "checkbox")]).id,
      2,
    );
  }
  for (const name of [
    "Unbezahlt",
    "Unpaid",
    "Nicht bezahlt",
    "not paid",
    "Unbezahlt?",
    "prepaid",
    "Teilnahmebezahlt",
  ]) {
    assert.throws(
      () => selectPaidField([field(1, name)]),
      /Missing or ambiguous payment checkbox/,
    );
  }
  assert.throws(
    () => selectPaidField([field(1, "Bezahlt"), field(2, "Bezahlt?")]),
    /ambiguous/,
  );
});

const response = {
  personId: 20,
  person: { domainAttributes: { firstName: "Test", lastName: "Participant" } },
  group: { title: "Test group" },
  groupMemberStatus: "active",
  fields: [
    { id: 1, name: "Betrag", value: "Erwachsene (69 €)" },
    { id: 2, name: "Bezahlt?", value: "0" },
  ],
};
const reference = { domain: "demo", groupId: "10", personId: "20" };
const fields = [field(1, "Betrag"), field(2, "Bezahlt?", "checkbox")];
test("active, requested and waiting members may pay with a server-side participant name", () => {
  for (const groupMemberStatus of ["active", "requested", "waiting"]) {
    assert.deepEqual(
      quoteFromResponse(reference, { ...response, groupMemberStatus }, fields),
      {
        groupName: "Test group",
        personName: "Test Participant",
        amountCents: 6900,
        paidFieldId: 2,
        paid: false,
      },
    );
  }
  for (const groupMemberStatus of ["deleted", "inactive", "", "unknown"])
    assert.throws(
      () =>
        quoteFromResponse(
          reference,
          { ...response, groupMemberStatus },
          fields,
        ),
      /Membership must/,
    );
  assert.throws(() =>
    quoteFromResponse({ ...reference, personId: "21" }, response, fields),
  );
});
test("missing and ambiguous payment fields fail before charging", () => {
  assert.throws(
    () => quoteFromResponse(reference, response, [field(1, "Betrag")]),
    /payment checkbox/,
  );
  assert.throws(
    () => quoteFromResponse(reference, response, [...fields, field(3, "Paid")]),
    /ambiguous/,
  );
  assert.throws(
    () =>
      quoteFromResponse(reference, response, [
        field(1, "Betrag"),
        field(2, "Bezahlt?", "text"),
      ]),
    /must be a checkbox/,
  );
  assert.throws(
    () =>
      quoteFromResponse(
        reference,
        { ...response, fields: response.fields.slice(0, 1) },
        fields,
      ),
    /not readable/,
  );
});
test("paid fields match exact names and reject missing or ambiguous fields", () => {
  assert.equal(
    selectField(
      [field(1, "Unbezahlt"), field(2, " Bezahlt ")],
      ["bezahlt", "paid"],
    ).id,
    2,
  );
  assert.throws(() =>
    selectField([field(1, "Unbezahlt")], ["bezahlt", "paid"]),
  );
  assert.throws(() =>
    selectField([field(1, "Bezahlt"), field(2, "Paid")], ["bezahlt", "paid"]),
  );
  assert.throws(() =>
    selectField(
      [{ ...field(2, "Bezahlt"), type: "person" }],
      ["bezahlt", "paid"],
    ),
  );
});
test("never treat unresolved choice IDs as prices", () => {
  const value = { id: 9, name: "Betrag", value: "20169" };
  assert.equal(resolveMemberFieldValues(value, []), null);
  assert.equal(
    resolveMemberFieldValues(value, [field(9, "Betrag", "select")]),
    null,
  );
  const choice = field(9, "Betrag", "multiselect");
  choice.field.options = [
    { id: "20169", name: "69 €" },
    { id: "20170", name: "10 €" },
  ];
  assert.deepEqual(resolveMemberFieldValues(value, [choice]), ["69 €"]);
  assert.deepEqual(
    resolveMemberFieldValues({ ...value, value: ["20169", "20170"] }, [choice]),
    ["69 €", "10 €"],
  );
  for (const input of ["999", "20169,20169", "20169,", ""])
    assert.equal(
      resolveMemberFieldValues({ ...value, value: input }, [choice]),
      null,
    );
});
