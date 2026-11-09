import { z } from "zod";

export const domainSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const idSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((value) => Number(value) <= 2147483647);
export const referenceSchema = z.object({
  domain: domainSchema,
  groupId: idSchema,
  personId: idSchema,
});
export type PaymentReference = z.infer<typeof referenceSchema>;

export function configuredDomains() {
  const domains: string[] = [];
  for (const value of (process.env.CHURCHPAY_DOMAINS ?? "").split(",")) {
    const parsed = domainSchema.safeParse(value.trim());
    if (!parsed.success) {
      console.error(JSON.stringify({ event: "tenant_domain_invalid" }));
      continue;
    }
    if (!domains.includes(parsed.data)) domains.push(parsed.data);
  }
  return domains;
}

export function getTenant(domain: string) {
  domainSchema.parse(domain);
  const domains = configuredDomains();
  if (!domains.includes(domain)) throw new Error("Unknown ChurchPay domain");
  try {
    return readTenant(domain, domains);
  } catch {
    // Zod errors may contain credentials: log only the validated tenant slug.
    console.error(
      JSON.stringify({ event: "tenant_configuration_invalid", domain }),
    );
    throw new Error(`Invalid configuration for ChurchPay tenant '${domain}'`);
  }
}

function readTenant(domain: string, domains: string[]) {
  const suffix = domain.toUpperCase().replaceAll("-", "_");
  const legacySuffix = (value: string) =>
    value.toUpperCase().replace(/[^A-Z]/g, "_");
  const value = (name: string) => {
    const canonical = process.env[`${name}_${suffix}`];
    if (canonical !== undefined) return canonical;
    const legacy = process.env[`${name}_${legacySuffix(domain)}`];
    if (
      legacy !== undefined &&
      domains.filter(
        (candidate) => legacySuffix(candidate) === legacySuffix(domain),
      ).length > 1
    ) {
      throw new Error(
        "Ambiguous legacy tenant suffix; configure digit-preserving variables",
      );
    }
    return legacy;
  };
  const required = z.string().trim().min(1);
  return {
    domain,
    churchToolsUrl: `https://${domain}.church.tools`,
    churchToolsToken: required.parse(value("CT_TOKEN")),
    clientId: required.parse(value("PAYPAL_CLIENT_ID")),
    clientSecret: required.parse(value("PAYPAL_CLIENT_SECRET")),
    merchantId: required.parse(value("PAYPAL_MERCHANT_ID")),
    environment: z.enum(["sandbox", "live"]).parse(value("PAYPAL_ENV")),
    webhookId: required.parse(value("PAYPAL_WEBHOOK_ID")),
  };
}
export type Tenant = ReturnType<typeof getTenant>;

export function validateConfiguration() {
  z.url()
    .refine((value) =>
      ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    )
    .parse(process.env.DATABASE_URL);
  for (const domain of configuredDomains()) {
    try {
      getTenant(domain);
    } catch {
      /* Invalid tenants are logged and fail only their own requests. */
    }
  }
}
