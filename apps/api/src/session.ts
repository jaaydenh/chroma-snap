import { hashObject, type CreateUploadSessionRequest, type UploadArtifactStatus } from "@chroma-snap/shared";

export interface StoredSession {
  sessionId: string;
  buildId: string;
  createdAt: string;
  expiresAt: string;
  request: CreateUploadSessionRequest;
  artifacts: UploadArtifactStatus[];
  finalized: boolean;
}

export function objectKeyForArtifact(sessionId: string, artifactId: string, request?: CreateUploadSessionRequest): string {
  const safeArtifactId = safeObjectSegment(artifactId);
  if (!request) {
    return `artifacts/${sessionId}/${safeArtifactId}`;
  }

  const repo = request.repository.fullName.split("/").map(safeObjectSegment).join("/");
  const commit = safeObjectSegment(request.git.commitSha);
  const artifactHash = hashObject({ artifactId }).slice(0, 12);
  return `artifacts/${request.repository.provider}/${repo}/${commit}/${sessionId}/${artifactHash}-${safeArtifactId}`;
}

function safeObjectSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "artifact";
}
