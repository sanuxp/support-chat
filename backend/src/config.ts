function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
const opt = (name: string, def = ""): string => process.env[name] || def;

export const config = {
  serverName: req("MATRIX_SERVER_NAME"),
  synapseUrl: opt("SYNAPSE_URL", "http://localhost:8009"), // internal URL the backend uses
  publicBaseUrl: req("MATRIX_PUBLIC_BASEURL"), // URL given to browsers
  asToken: req("AS_TOKEN"),
  hsToken: req("HS_TOKEN"),
  backendPort: Number(opt("BACKEND_PORT", "3000")),
  appservicePort: Number(opt("APPSERVICE_PORT", "9000")),
  databaseUrl: req("DATABASE_URL"),
  jwtSecret: req("BACKEND_JWT_SECRET"),
  adminApiToken: opt("ADMIN_API_TOKEN"),
  customerAuthMode: opt("CUSTOMER_AUTH_MODE", "anonymous") as "anonymous" | "external_jwt",
  externalJwtPublicKey: opt("EXTERNAL_JWT_PUBLIC_KEY"),
  enableE2ee: opt("ENABLE_E2EE", "false") === "true",
};

export const AI_LOCALPART = "ai_agent";
export const ADMIN_LOCALPART = "svc_admin";
export const aiUserId = `@${AI_LOCALPART}:${config.serverName}`;
export const adminUserId = `@${ADMIN_LOCALPART}:${config.serverName}`;
