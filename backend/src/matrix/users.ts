import { config } from "../config.js";
import { MatrixHttpError, synapse } from "./synapse.js";

export const mxid = (localpart: string) => `@${localpart}:${config.serverName}`;

/** Register an appservice-owned user (idempotent). */
export async function ensureUser(localpart: string): Promise<void> {
  try {
    await synapse("POST", "/_matrix/client/v3/register", {
      body: { type: "m.login.application_service", username: localpart },
    });
  } catch (e) {
    if (e instanceof MatrixHttpError && e.errcode === "M_USER_IN_USE") return;
    throw e;
  }
}

/** Issue an access token for an appservice-owned user via m.login.application_service. */
export async function loginAs(
  localpart: string,
  deviceDisplayName = "Support chat session",
): Promise<{ accessToken: string; deviceId: string; userId: string }> {
  const r = await synapse<{ access_token: string; device_id: string; user_id: string }>(
    "POST",
    "/_matrix/client/v3/login",
    {
      body: {
        type: "m.login.application_service",
        identifier: { type: "m.id.user", user: localpart },
        initial_device_display_name: deviceDisplayName,
      },
    },
  );
  return { accessToken: r.access_token, deviceId: r.device_id, userId: r.user_id };
}
