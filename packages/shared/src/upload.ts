import type { BuildManifest } from "./manifest.js";

export interface UploadArtifactIntent {
  id: string;
  kind: "screenshot" | "manifest" | "log" | "diff";
  fileName: string;
  contentType: string;
  sha256?: string;
  byteSize?: number;
}

export interface CreateUploadSessionRequest {
  repository: BuildManifest["repository"];
  git: BuildManifest["git"];
  project: BuildManifest["project"];
  github?: BuildManifest["github"];
  configHash: string;
  artifacts: UploadArtifactIntent[];
}

export interface UploadTarget {
  artifactId: string;
  method: "PUT";
  url: string;
  headers?: Record<string, string>;
  objectKey: string;
  expiresAt: string;
}

export interface UploadSessionResponse {
  sessionId: string;
  buildId: string;
  expiresAt: string;
  uploadTargets: UploadTarget[];
}

export interface FinalizeUploadSessionRequest {
  manifest: BuildManifest;
}

export interface FinalizeUploadSessionResponse {
  buildId: string;
  status: "queued" | "accepted";
  reportUrl?: string;
}
