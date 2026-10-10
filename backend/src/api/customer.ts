import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { pool } from "../db/db.js";
import { purgeRoom } from "../matrix/admin.js";
import { createConversationRoom } from "../matrix/rooms.js";
import { clearFallback } from "../routing/handoff.js";
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

/** Resolve the stable external reference + visitorId for this request, per CUSTOMER_AUTH_MODE. */
function resolveIdentity(req: FastifyRequest): { externalRef: string; visitorId?: string } {
  if (config.customerAuthMode === "external_jwt") {
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Bearer ")) throw httpError(401, "Missing host-app JWT");
    try {
      const claims = jwt.verify(h.slice(7), config.externalJwtPublicKey) as jwt.JwtPayload;
      if (!claims.sub) throw new Error("no sub");
      return { externalRef: `ext:${claims.sub}` };
    } catch {
      throw httpError(401, "Invalid host-app JWT");
    }
  }
  const body = (req.body ?? {}) as { visitorId?: string };
  const visitorId = body.visitorId && UUID_RE.test(body.visitorId) ? body.visitorId : randomUUID();
  return { externalRef: `anon:${visitorId}`, visitorId };
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
    const { externalRef, visitorId } = resolveIdentity(req);

    // customer row (stable per external_ref)
    let customer = (await pool.query("SELECT id, matrix_user_id FROM customers WHERE external_ref=$1", [externalRef])).rows[0];
    if (!customer) {
      const id = randomUUID();
      const matrixUserId = mxid(`customer_${id}`);
      customer = (
        await pool.query(
          `INSERT INTO customers (id, external_ref, matrix_user_id) VALUES ($1,$2,$3)
           ON CONFLICT (external_ref) DO UPDATE SET external_ref = EXCLUDED.external_ref
           RETURNING id, matrix_user_id`,
          [id, externalRef, matrixUserId],
        )
      ).rows[0];
    }
    const localpart = (customer.matrix_user_id as string).slice(1).split(":")[0];

    await ensureUser(localpart);
    // issuing a token and looking up the open conversation are independent
    const [login, open] = await Promise.all([
      loginAs(localpart),
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
      backendToken,
    };
  });
}
