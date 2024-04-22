import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { ChurchToolsClient } from "@churchtools/churchtools-client";
import { getEnvForDomain } from "@/lib/domainenv";
import { GroupMemberField, Member } from "@/lib/types";

export function getChurchToolsClient(domain: string) {
  const token = getEnvForDomain("CT_TOKEN", decodeURIComponent(domain));
  if (!token) {
    return null;
  }

  const churchToolsClient = new ChurchToolsClient(
    `https://${domain}.church.tools`,
    token,
  );
  churchToolsClient.setCookieJar(wrapper, new CookieJar());
  return churchToolsClient;
}

export async function getMember(
  churchToolsClient: ChurchToolsClient,
  groupId: string,
  personId: string,
) {
  const members: Member[] = await churchToolsClient.getAllPages(
    `/groups/${groupId}/members`,
  );
  return members.find((member) => member.personId === +personId);
}

export function getPaidField(member: Member) {
  return member.fields.find((field) =>
    ["bezahlt", "paid"].includes(field.name.toLowerCase()),
  );
}

export function extractEuroAmount(input: string): number | null {
  const match = /(\d+\s?€)/g.exec(input);

  if (match && match[1]) {
    const amount = parseFloat(match[1].replace("€", "").replace(" ", ""));
    return amount;
  }

  return null;
}

export function getAmountField(member: Member) {
  return member.fields.find((field) =>
    ["betrag", "preis", "buchung", "auswahl"].includes(
      field.name.toLowerCase(),
    ),
  );
}

export async function getGroupMemberFields(
  churchToolsClient: ChurchToolsClient,
  groupId: string,
) {
  const fields: GroupMemberField[] = await churchToolsClient.get(
    `/groups/${groupId}/memberfields`,
  );
  return fields;
}

export async function setPaid(
  churchToolsClient: ChurchToolsClient,
  groupId: string,
  personId: string,
) {
  const fields = await getGroupMemberFields(churchToolsClient, groupId);
  const paidField = fields.find((field) =>
    ["bezahlt", "paid"].includes(field.field.name.toLowerCase()),
  );
  const paidFieldId = paidField?.field.id;
  if (!paidFieldId) {
    console.error("paidField not found");
    return;
  }
  await churchToolsClient.put(`/groups/${groupId}/members/${personId}`, {
    fields: { [paidFieldId]: "1" },
  });
}
