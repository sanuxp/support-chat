import { config } from "../config.js";

export class MatrixHttpError extends Error {
  constructor(public status: number, public errcode: string, message: string) {
    super(`${status} ${errcode}: ${message}`);
  }
}

/** Raw client-server / admin API call. `actAs` impersonates an appservice-owned user. */
export async function synapse<T = any>(
  method: string,
  path: string,
  opts: { token?: string; actAs?: string; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, config.synapseUrl);
  if (opts.actAs) url.searchParams.set("user_id", opts.actAs);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token ?? config.asToken}`,
      "Content-Type": "application/json",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new MatrixHttpError(res.status, data.errcode ?? "UNKNOWN", data.error ?? res.statusText);
  return data as T;
}

export const enc = encodeURIComponent;
