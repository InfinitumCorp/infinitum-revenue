import type { Db } from "./db.js";
import type { PaymentProvider } from "./payments.js";
import type { CidVerifier } from "./cid.js";

export interface Config {
  publicUrl: string;            // where Checkout returns the customer, e.g. https://infinitumcorporation.ai
  /** Hosts (and their subdomains) that product apps may ask Checkout / the portal to return to. https only. */
  returnHosts?: string[];
  adminApiKey: string;          // platform operator key for admin routes
  /**
   * Server-to-server key for the Cumulus billing hub (mail.cumuluscloud.app): with it and an
   * `X-Cumulus-Id` header the hub acts for that Cumulus ID, through the same cid_links mapping
   * product apps use with a Cumulus ID token. Empty or unset: off.
   */
  cidPartnerKey?: string;
  licenceSigningKeyPem?: string; // Ed25519 PKCS8 PEM; generated per process when absent (dev only)
  /** Token (crypto) payouts stay off until counsel signs off on the token programme. */
  tokenPayoutsEnabled: boolean;
}

/** `cid`: verifies Cumulus ID access tokens so product apps can call the customer API as the signed-in user. */
export interface Ctx { db: Db; pay: PaymentProvider; config: Config; cid?: CidVerifier }

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const fail = (status: number, code: string, message: string): never => { throw new AppError(status, code, message); };

export async function audit(db: Db, orgId: string | null, actor: string, action: string, detail: unknown = {}) {
  const { newId } = await import("./db.js");
  await db.query("insert into audit_log (id, org_id, actor, action, detail) values ($1,$2,$3,$4,$5)",
    [newId("aud"), orgId, actor, action, JSON.stringify(detail)]);
}
