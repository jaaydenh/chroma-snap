import { createHmac, timingSafeEqual } from "node:crypto";

export interface ArtifactSignatureInput {
  objectKey: string;
  expiresAt: string;
  secret: string;
  buildId?: string;
}

export interface SignedArtifactUrlInput extends ArtifactSignatureInput {
  publicUrl: string;
  route?: string;
}

export interface ArtifactSignatureVerificationResult {
  ok: boolean;
  error?: string;
}

export function createArtifactSignature(input: ArtifactSignatureInput): string {
  assertArtifactSignatureInput(input);
  return createHmac("sha256", input.secret).update(signaturePayload(input)).digest("base64url");
}

export function createSignedArtifactUrl(input: SignedArtifactUrlInput): string {
  const route = input.route ?? "/v1/artifacts";
  const url = new URL(route, input.publicUrl);
  url.searchParams.set("objectKey", input.objectKey);
  url.searchParams.set("expiresAt", input.expiresAt);
  if (input.buildId) {
    url.searchParams.set("buildId", input.buildId);
  }
  url.searchParams.set("signature", createArtifactSignature(input));
  return url.toString();
}

export function verifyArtifactSignature(input: ArtifactSignatureInput & { signature: string; now?: Date }): ArtifactSignatureVerificationResult {
  if (!input.objectKey) {
    return { ok: false, error: "objectKey is required." };
  }
  if (!input.expiresAt) {
    return { ok: false, error: "expiresAt is required." };
  }
  if (!input.signature) {
    return { ok: false, error: "signature is required." };
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { ok: false, error: "expiresAt is invalid." };
  }
  if (expiresAt < (input.now ?? new Date()).getTime()) {
    return { ok: false, error: "Signed artifact URL has expired." };
  }
  const expected = Buffer.from(createArtifactSignature(input), "utf8");
  const actual = Buffer.from(input.signature, "utf8");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: "Signed artifact URL signature is invalid." };
  }
  return { ok: true };
}

function assertArtifactSignatureInput(input: ArtifactSignatureInput): void {
  if (!input.secret) {
    throw new Error("Artifact signing secret is required.");
  }
  if (!input.objectKey) {
    throw new Error("Artifact objectKey is required.");
  }
  if (!input.expiresAt || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("Artifact signature expiresAt must be a valid date.");
  }
}

function signaturePayload(input: ArtifactSignatureInput): string {
  return [input.buildId ?? "", input.objectKey, input.expiresAt].join("\n");
}
