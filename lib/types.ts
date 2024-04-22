export interface Person {
  title: string;
  domainType: "person";
  domainIdentifier: string;
  apiUrl: string;
  frontendUrl: string;
  imageUrl: string | null;
  icon: "user";
  domainAttributes: {
    firstName: string;
    lastName: string;
    guid: string;
  };
}

export interface Group {
  title: string;
  domainType: "group";
  domainIdentifier: string;
  apiUrl: string;
  frontendUrl: string;
  imageUrl: string | null;
  icon: "users";
  domainAttributes: { note: string; groupStatusId: number; campusId: number };
}

export interface Member {
  personId: number;
  person: Person;
  group: Group;
  groupTypeRoleId: number;
  groupMemberStatus: string;
  memberStartDate: string;
  registeredBy: null;
  comment: string;
  memberEndDate: string | null;
  waitinglistPosition: null;
  fields: MemberField[];
  personFields: unknown[];
}

export interface MemberField {
  id: number;
  name: string;
  value: string;
  sortKey: number;
}

export interface GroupMemberField {
  type: "group" | "person";
  field: {
    id: number;
    groupId: number;
    name: string;
    fieldName: string;
    note: string;
    sortKey: number;
    fieldTypeCode: string;
    fieldTypeId: number;
    securityLevel: number;
    defaultValue: string;
    maxLength: number;
    options: never[];
    useInRegistrationForm: boolean;
    requiredInRegistrationForm: boolean;
  };
}

export interface PaymentInfoError {
  type: "error";
  message: string;
}

export interface PaymentInfoData {
  type: "data";
  groupName: string;
  clientId: string;
  amount: number;
}

export type PaymentInfo = PaymentInfoError | PaymentInfoData;
