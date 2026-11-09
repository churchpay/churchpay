import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { ChurchToolsClient } from "@churchtools/churchtools-client";
import { z } from "zod";
import { getTenant, referenceSchema, type PaymentReference } from "./config";
import { sumEuroCents } from "./money";
import {
  groupMemberFieldSchema,
  memberSchema,
  type GroupMemberField,
  type MemberField,
  type Quote,
} from "./types";

export function getChurchToolsClient(domain: string) {
  const tenant = getTenant(domain);
  const client = new ChurchToolsClient(
    tenant.churchToolsUrl,
    tenant.churchToolsToken,
  );
  client.setCookieJar((axios) => {
    axios.defaults.maxRedirects = 0;
    return wrapper(axios);
  }, new CookieJar());
  client.setRequestTimeout(10000);
  return client;
}

export function selectField(fields: GroupMemberField[], names: string[]) {
  const matches = fields.filter(
    ({ type, field }) =>
      type === "group" && names.includes(field.name.trim().toLowerCase()),
  );
  if (matches.length !== 1)
    throw new Error("Missing or ambiguous payment field");
  return matches[0].field;
}

export function resolveMemberFieldValues(
  memberField: MemberField,
  fields: GroupMemberField[],
): string[] | null {
  const metadata = fields.find(
    ({ type, field }) => type === "group" && field.id === memberField.id,
  )?.field;
  if (!metadata) return null;
  const value = memberField.value;
  if (value === null) return [];
  const options = metadata.options ?? [];
  const isSelection = /select|option/i.test(metadata.fieldTypeCode);
  if (!options.length)
    return isSelection ? null : Array.isArray(value) ? value : [value];
  const ids = (Array.isArray(value) ? value : value.split(",")).map((id) =>
    id.trim(),
  );
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  const labels = ids.map(
    (id) => options.find((option) => String(option.id) === id)?.name,
  );
  return labels.some((label) => label === undefined)
    ? null
    : (labels as string[]);
}

export function selectPaidField(fields: GroupMemberField[]) {
  const matches = fields.filter(
    ({ type, field }) =>
      type === "group" &&
      /(?:^|[^\p{L}\p{N}])(?:bezahlt|paid)(?=$|[^\p{L}\p{N}])/iu.test(
        field.name,
      ) &&
      !/(?:unbezahlt|unpaid|nicht\s+bezahlt|not\s+paid)/iu.test(field.name),
  );
  if (matches.length !== 1)
    throw new Error(
      "Missing or ambiguous payment checkbox: expected one field containing the word 'Bezahlt' or 'Paid' (for example 'Bezahlt?'), excluding 'Unbezahlt' and 'Unpaid'",
    );
  return matches[0].field;
}

export async function loadQuote(reference: PaymentReference): Promise<Quote> {
  referenceSchema.parse(reference);
  const client = getChurchToolsClient(reference.domain);
  const path = `/groups/${reference.groupId}`;
  const [rawMember, rawFields] = await Promise.all([
    client.get(`${path}/members/${reference.personId}`),
    client.get(`${path}/memberfields`),
  ]);
  return quoteFromResponse(reference, rawMember, rawFields);
}

export function quoteFromResponse(
  reference: PaymentReference,
  rawMember: unknown,
  rawFields: unknown,
): Quote {
  referenceSchema.parse(reference);
  const member = memberSchema.parse(rawMember);
  const fields = z.array(groupMemberFieldSchema).parse(rawFields);
  if (
    member.personId !== Number(reference.personId) ||
    !["active", "requested", "waiting"].includes(member.groupMemberStatus)
  )
    throw new Error("Membership must be active, requested or waiting");
  const paid = selectPaidField(fields);
  if (paid.fieldTypeCode !== "checkbox")
    throw new Error("Paid field must be a checkbox");
  const amount = selectField(fields, ["betrag", "preis", "buchung", "auswahl"]);
  const value = member.fields.find((field) => field.id === amount.id);
  const paidMemberField = member.fields.find((field) => field.id === paid.id);
  if (!paidMemberField) throw new Error("Paid field is not readable");
  const paidValue = paidMemberField.value;
  if (
    paidValue !== "0" &&
    paidValue !== "1" &&
    paidValue !== null &&
    paidValue !== undefined &&
    paidValue !== ""
  )
    throw new Error("Invalid paid field");
  const labels = value && resolveMemberFieldValues(value, fields);
  const cents = labels && sumEuroCents(labels);
  if (!cents) throw new Error("Invalid payment amount");
  const personName =
    `${member.person.domainAttributes.firstName} ${member.person.domainAttributes.lastName}`.trim();
  if (!personName) throw new Error("Missing participant name");
  return {
    groupName: member.group.title,
    personName,
    amountCents: cents,
    paidFieldId: paid.id,
    paid: paidValue === "1",
  };
}

export async function setPaid(
  reference: PaymentReference,
  fieldId: number,
  paid: boolean,
) {
  referenceSchema.parse(reference);
  const client = getChurchToolsClient(reference.domain);
  const fields = z
    .array(groupMemberFieldSchema)
    .parse(await client.get(`/groups/${reference.groupId}/memberfields`));
  const field = selectPaidField(fields);
  if (field.id !== fieldId || field.fieldTypeCode !== "checkbox")
    throw new Error("Paid field configuration changed");
  await client.put(
    `/groups/${reference.groupId}/members/${reference.personId}`,
    { fields: { [fieldId]: paid ? "1" : "0" } },
  );
}
