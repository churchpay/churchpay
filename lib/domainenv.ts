export function getEnvForDomain(env: string, domain: string) {
  return process.env[`${env}_${domain.toUpperCase().replace(/[^A-Z]/g, "_")}`];
}
