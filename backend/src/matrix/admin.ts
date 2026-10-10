import { ADMIN_LOCALPART } from "../config.js";
import { enc, MatrixHttpError, synapse } from "./synapse.js";
import { loginAs } from "./users.js";

// @svc_admin is an appservice user promoted to server admin by scripts/init.sh.
// Its token is obtained on demand via m.login.application_service and refreshed if Synapse rejects it.
let adminToken: string | undefined;

async function token(force = false): Promise<string> {
  if (!adminToken || force) adminToken = (await loginAs(ADMIN_LOCALPART, "Support backend admin")).accessToken;
  return adminToken;
}

async function adminCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await synapse<T>(method, path, { token: await token(), body });
  } catch (e) {
    if (e instanceof MatrixHttpError && e.status === 401) {
      return synapse<T>(method, path, { token: await token(true), body });
    }
    throw e;
  }
}

/**
 * Delete a room with Synapse's Delete Room API v2 (purge: true removes it from the database).
 * The purge runs in the background; we wait briefly for it so the caller can report the outcome.
 */
export async function purgeRoom(roomId: string): Promise<"complete" | "pending" | "failed"> {
  await adminCall("DELETE", `/_synapse/admin/v2/rooms/${enc(roomId)}`, { purge: true, block: true });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await adminCall<{ results: { status: string }[] }>("GET", `/_synapse/admin/v2/rooms/${enc(roomId)}/delete_status`);
    const status = s.results?.[0]?.status;
    if (status === "complete") return "complete";
    if (status === "failed") return "failed";
  }
  return "pending";
}
