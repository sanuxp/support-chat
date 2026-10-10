import { Appservice, type IAppserviceRegistration } from "matrix-bot-sdk";
import { AI_LOCALPART, config } from "../config.js";

/**
 * matrix-bot-sdk requires exactly ONE user namespace in the registration object it is given
 * (see vendor/matrix-bot-sdk/src/appservice/Appservice.ts constructor). Synapse reads the real
 * registration YAML (which also owns @svc_admin), so this object is only the SDK's view of it.
 */
const registration: IAppserviceRegistration = {
  id: "support-backend",
  url: `http://backend:${config.appservicePort}`,
  as_token: config.asToken,
  hs_token: config.hsToken,
  sender_localpart: AI_LOCALPART,
  namespaces: {
    users: [{ exclusive: true, regex: `@customer_.*:${config.serverName.replace(/\./g, "\\.")}` }],
    aliases: [],
    rooms: [],
  },
  rate_limited: false,
};

export const appservice = new Appservice({
  port: config.appservicePort,
  bindAddress: "0.0.0.0",
  homeserverName: config.serverName,
  homeserverUrl: config.synapseUrl,
  registration,
});

export async function startAppservice(): Promise<void> {
  await appservice.begin();
  await appservice.botIntent.ensureRegistered();
}
