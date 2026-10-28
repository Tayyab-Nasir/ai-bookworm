/** Explicit server-only readiness coordinator. This is not a probe, launcher,
 * entitlement, environment flag or production registration. Its trusted
 * verifiers must independently authenticate their evidence; a static flag or
 * private-service identity proof alone never establishes readiness. */
import { z } from "zod";

const binding = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const time = z.number().int().nonnegative().safe();
const expectedSchema = z.object({ deploymentId: binding, projectRef: binding, serviceId: binding, keyId: binding, schemaRevision: binding }).strict();
const identitySchema = z.object({ deploymentId: binding, serviceId: binding, keyId: binding, identityVerified: z.literal(true), observedAt: time }).strict();
const databaseSchema = z.object({ deploymentId: binding, projectRef: binding, schemaRevision: binding, aclVerified: z.literal(true), observedAt: time }).strict();
const workerSchema = z.object({ deploymentId: binding, projectRef: binding, serviceId: binding, keyId: binding,
  kind: z.literal("customer_generation"), ready: z.literal(true), observedAt: time, expiresAt: time }).strict();
const trusted = new WeakSet<object>();

export type CustomerAiReadiness = { check(): Promise<boolean> };
type Verifier = (signal: AbortSignal) => Promise<unknown>;

export function customerAiReadiness(config: {
  expected: z.infer<typeof expectedSchema>;
  operatorEnabled: () => boolean;
  verifyIdentity: Verifier;
  verifyDatabase: Verifier;
  verifyWorker: Verifier;
  maxAgeMs?: number;
  timeoutMs?: number;
  now?: () => number;
}): CustomerAiReadiness {
  const expected = expectedSchema.safeParse(config?.expected);
  const maxAgeMs = config?.maxAgeMs ?? 5_000, timeoutMs = config?.timeoutMs ?? 5_000;
  if (!expected.success || typeof config?.operatorEnabled !== "function" || typeof config?.verifyIdentity !== "function"
    || typeof config?.verifyDatabase !== "function" || typeof config?.verifyWorker !== "function"
    || !Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 30_000
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000
    || (config.now !== undefined && typeof config.now !== "function")) {
    throw new Error("Customer AI readiness configuration is invalid.");
  }
  const scope = expected.data, now = config.now ?? Date.now;
  const { operatorEnabled, verifyIdentity, verifyDatabase, verifyWorker } = config;
  const result: CustomerAiReadiness = {
    async check() {
      const aborter = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (operatorEnabled() !== true) return false;
        const interrupted = new Promise<never>((_, reject) => { timer = setTimeout(() => { aborter.abort(); reject(new Error()); }, timeoutMs); });
        const proofs = await Promise.race([Promise.all([
          verifyIdentity(aborter.signal), verifyDatabase(aborter.signal), verifyWorker(aborter.signal),
        ]), interrupted]);
        if (aborter.signal.aborted || operatorEnabled() !== true) return false;
        const identity = identitySchema.parse(proofs[0]), database = databaseSchema.parse(proofs[1]), worker = workerSchema.parse(proofs[2]);
        const current = now(); if (!Number.isSafeInteger(current) || current < 0) return false;
        const fresh = (at: number) => at <= current && at >= current - maxAgeMs;
        return fresh(identity.observedAt) && fresh(database.observedAt) && fresh(worker.observedAt)
          && worker.expiresAt > current && worker.expiresAt <= worker.observedAt + maxAgeMs
          && identity.deploymentId === scope.deploymentId && identity.serviceId === scope.serviceId && identity.keyId === scope.keyId
          && database.deploymentId === scope.deploymentId && database.projectRef === scope.projectRef && database.schemaRevision === scope.schemaRevision
          && worker.deploymentId === scope.deploymentId && worker.projectRef === scope.projectRef
          && worker.serviceId === scope.serviceId && worker.keyId === scope.keyId;
      } catch { return false; }
      finally { if (timer) clearTimeout(timer); aborter.abort(); }
    },
  };
  Object.freeze(result); trusted.add(result); return result;
}

/** Only instances created above can satisfy an injected application gate. */
export async function isCustomerAiReady(value: CustomerAiReadiness | undefined): Promise<boolean> {
  if (!value || !trusted.has(value)) return false;
  try { return await value.check() === true; } catch { return false; }
}
