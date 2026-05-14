import type { ArtifactStore, BuildManifest } from "@chroma-snap/shared";
import type { StoredSession } from "./session.js";

export interface UploadIntegrityResult {
  ok: boolean;
  errors: string[];
}

export async function verifyUploadIntegrity(session: StoredSession, manifest: BuildManifest, store: ArtifactStore): Promise<UploadIntegrityResult> {
  const errors: string[] = [];
  const statusesByObjectKey = new Map(session.artifacts.map((artifact) => [artifact.objectKey, artifact]));
  const statusesById = new Map(session.artifacts.map((artifact) => [artifact.id, artifact]));

  for (const artifact of session.artifacts) {
    const verification = await store.verifyArtifact(artifact.objectKey, { sha256: artifact.sha256, byteSize: artifact.byteSize });
    if (!verification.exists) {
      artifact.status = "failed";
      artifact.verificationError = `Artifact '${artifact.id}' was declared but never uploaded.`;
      errors.push(artifact.verificationError);
      continue;
    }

    artifact.actualSha256 = verification.sha256;
    artifact.actualByteSize = verification.byteSize;
    if (!verification.integrityOk) {
      artifact.status = "failed";
      artifact.verificationError = `Artifact '${artifact.id}' failed integrity verification: ${verification.error ?? "unknown mismatch"}.`;
      errors.push(artifact.verificationError);
      continue;
    }
    artifact.status = "verified";
    artifact.verificationError = undefined;
  }

  for (const snapshot of manifest.snapshots) {
    if (snapshot.status !== "captured") {
      continue;
    }
    if (!snapshot.image?.objectKey) {
      errors.push(`Snapshot '${snapshot.story.id}' is captured but image.objectKey is missing.`);
      continue;
    }

    const sessionArtifact = statusesByObjectKey.get(snapshot.image.objectKey) ?? statusesById.get(`${snapshot.identityKey}.png`);
    if (!sessionArtifact) {
      errors.push(`Snapshot '${snapshot.story.id}' references objectKey '${snapshot.image.objectKey}' that is not part of this upload session.`);
      continue;
    }
    if (snapshot.image.sha256 !== sessionArtifact.actualSha256) {
      errors.push(`Snapshot '${snapshot.story.id}' sha256 does not match uploaded artifact: expected ${snapshot.image.sha256}, got ${sessionArtifact.actualSha256 ?? "missing"}.`);
    }
    if (snapshot.image.byteSize !== undefined && sessionArtifact.actualByteSize !== undefined && snapshot.image.byteSize !== sessionArtifact.actualByteSize) {
      errors.push(`Snapshot '${snapshot.story.id}' byteSize does not match uploaded artifact: expected ${snapshot.image.byteSize}, got ${sessionArtifact.actualByteSize}.`);
    }
  }

  return { ok: errors.length === 0, errors };
}
