/** Synthetic evidence for route tests only; no external calls or credentials. */
import { customerAiReadiness } from "../lib/customer-ai-readiness.js";
export function syntheticCustomerAiReadiness(enabled: () => boolean = () => true) {
  const expected = { deploymentId: "synthetic-deployment", projectRef: "synthetic-project", serviceId: "synthetic-private-service", keyId: "synthetic-key", schemaRevision: "synthetic-schema" };
  return customerAiReadiness({ expected, operatorEnabled: enabled,
    verifyIdentity: async () => ({ deploymentId: expected.deploymentId, serviceId: expected.serviceId, keyId: expected.keyId, identityVerified: true, observedAt: Date.now() }),
    verifyDatabase: async () => ({ deploymentId: expected.deploymentId, projectRef: expected.projectRef, schemaRevision: expected.schemaRevision, aclVerified: true, observedAt: Date.now() }),
    verifyWorker: async () => { const observedAt = Date.now(); return { deploymentId: expected.deploymentId, projectRef: expected.projectRef,
      serviceId: expected.serviceId, keyId: expected.keyId, kind: "customer_generation", ready: true, observedAt, expiresAt: observedAt + 4_000 }; },
  });
}
