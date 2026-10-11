import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { resolveProfile, mergeProfile, profileFromClaims, profileFromHeaders, sameProfile, storedFromRow, type ProvidedProfile } from "../customer/profile.js";
import { pool } from "../db/db.js";
import { purgeRoom } from "../matrix/admin.js";
import { createConversationRoom } from "../matrix/rooms.js";
import { clearFallback } from "../routing/handoff.js";
import { enc, synapse } from "../matrix/synapse.js";
import { ensureUser, loginAs, mxid } from "../matrix/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BackendTokenClaims { sub: string; mx: string }

export function verifyBackendToken(req: FastifyRequest): BackendTokenClaims {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) throw httpError(401, "Missing token");
  try {
    return jwt.verify(h.slice(7), config.jwtSecret) as BackendTokenClaims;
  } catch {
    throw httpError(401, "Invalid token");
  }
}

export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Resolve the stable external reference, visitorId and the host-supplied profile for this request,
 * per CUSTOMER_AUTH_MODE. In external_jwt mode verified JWT claims win over headers.
 */
function resolveIdentity(req: FastifyRequest): { externalRef: string; visitorId?: string; provided: ProvidedProfile } {
  const fromHeaders = profileFromHeaders(req.headers);
  if (config.customerAuthMode === "external_jwt") {
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Bearer ")) throw httpError(401, "Missing host-app JWT");
    try {
      const claims = jwt.verify(h.slice(7), config.externalJwtPublicKey) as jwt.JwtPayload;
      if (!claims.sub) throw new Error("no sub");
      const fromClaims = profileFromClaims(claims);
      const provided: ProvidedProfile = {
        name: fromClaims.name ?? fromHeaders.name,
        email: fromClaims.email ?? fromHeaders.email,
        phone: fromClaims.phone ?? fromHeaders.phone,
        metadata: fromClaims.metadata ?? fromHeaders.metadata,
      };
      return { externalRef: `ext:${claims.sub}`, provided };
    } catch {
      throw httpError(401, "Invalid host-app JWT");
    }
  }
  const body = (req.body ?? {}) as { visitorId?: string };
  const visitorId = body.visitorId && UUID_RE.test(body.visitorId) ? body.visitorId : randomUUID();
  return { externalRef: `anon:${visitorId}`, visitorId, provided: fromHeaders };
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // Permanently delete one of the caller's own conversations (room purged via the Synapse admin API).
  app.delete<{ Params: { roomId: string } }>("/api/customer/conversations/:roomId", async (req, reply) => {
    const claims = verifyBackendToken(req);
    const r = await pool.query(
      "SELECT id FROM conversations WHERE room_id=$1 AND customer_id=$2 AND deleted_at IS NULL",
      [req.params.roomId, claims.sub],
    );
    if (!r.rows[0]) throw httpError(404, "Conversation not found"); // also covers rooms owned by someone else
    clearFallback(req.params.roomId);
    const result = await purgeRoom(req.params.roomId);
    if (result === "failed") throw httpError(502, "Could not delete the conversation, please try again");
    await pool.query("UPDATE conversations SET deleted_at=now(), updated_at=now() WHERE id=$1", [r.rows[0].id]);
    console.log(JSON.stringify({ msg: "conversation deleted", roomId: req.params.roomId, purge: result }));
    return reply.code(result === "complete" ? 200 : 202).send({ deleted: true, purge: result });
  });

  app.post("/api/customer/session", async (req) => {
    const { externalRef, visitorId, provided } = resolveIdentity(req);

    // customer row (stable per external_ref)
    const COLS = "id, matrix_user_id, name, email, phone, metadata";
    let customer = (await pool.query(`SELECT ${COLS} FROM customers WHERE external_ref=$1`, [externalRef])).rows[0];
    let created = false;
    if (!customer) {
      const id = randomUUID();
      const matrixUserId = mxid(`customer_${id}`);
      customer = (
        await pool.query(
          `INSERT INTO customers (id, external_ref, matrix_user_id) VALUES ($1,$2,$3)
           ON CONFLICT (external_ref) DO UPDATE SET external_ref = EXCLUDED.external_ref
           RETURNING ${COLS}`,
          [id, externalRef, matrixUserId],
        )
      ).rows[0];
      created = true;
    }
    const localpart = (customer.matrix_user_id as string).slice(1).split(":")[0];

    // merge what the host page sent with what we stored; unsent fields keep their stored value
    const before = storedFromRow(customer);
    const merged = mergeProfile(before, provided);
    const profile = resolveProfile(merged);
    const changed = !sameProfile(before, merged);
    if (changed) {
      await pool.query("UPDATE customers SET name=$2, email=$3, phone=$4, metadata=$5 WHERE id=$1", [
        customer.id, merged.name, merged.email, merged.phone, JSON.stringify(merged.metadata),
      ]);
    }

    await ensureUser(localpart);
    // show the customer's name (not the uuid) to agents: set it when new or when the name changed
    const nameChanged = created || merged.name !== before.name;
    // issuing a token, the display name and the open-conversation lookup are independent
    const [login, , open] = await Promise.all([
      loginAs(localpart),
      nameChanged
        ? synapse("PUT", `/_matrix/client/v3/profile/${enc(customer.matrix_user_id)}/displayname`, {
            actAs: customer.matrix_user_id, body: { displayname: profile.name },
          }).catch(() => {}) // cosmetic: never block the session on it
        : Promise.resolve(),
      pool.query(
        `SELECT room_id FROM conversations
         WHERE customer_id=$1 AND deleted_at IS NULL AND status <> 'closed'
         ORDER BY created_at DESC LIMIT 1`,
        [customer.id],
      ),
    ]);
    // open conversation or create a new one
    let conv = open.rows[0];
    if (!conv) {
      const roomId = await createConversationRoom(customer.matrix_user_id, externalRef);
      await pool.query("INSERT INTO conversations (id, customer_id, room_id, status) VALUES ($1,$2,$3,'ai')", [
        randomUUID(), customer.id, roomId,
      ]);
      conv = { room_id: roomId };
    }

    const backendToken = jwt.sign({ sub: customer.id, mx: customer.matrix_user_id } satisfies BackendTokenClaims, config.jwtSecret, {
      expiresIn: "12h",
    });
    return {
      visitorId,
      homeserverUrl: config.publicBaseUrl,
      userId: login.userId,
      accessToken: login.accessToken,
      deviceId: login.deviceId,
      roomId: conv.room_id,
      profile: { name: profile.name, email: profile.email, phone: profile.phone },
      backendToken,
    };
  });
}
