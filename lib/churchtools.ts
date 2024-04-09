import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { ChurchToolsClient } from "@churchtools/churchtools-client";
import { getEnvForDomain } from "@/lib/domainenv";
import { Member } from "@/lib/types";

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

export async function setPaid(
  churchToolsClient: ChurchToolsClient,
  groupId: string,
  personId: string,
) {
  const member = await getMember(churchToolsClient, groupId, personId);
  const paidField = getPaidField(member!)?.id + "";
  await churchToolsClient.put(`/groups/${groupId}/members/${personId}`, {
    fields: { [paidField]: "1" },
  });
}
