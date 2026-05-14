import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertValidManifest,
  FileArtifactStore,
  type ArtifactStore,
  type CreateUploadSessionRequest,
  type FinalizeUploadSessionRequest,
  type FinalizeUploadSessionResponse,
  type UploadSessionResponse,
} from "@chroma-snap/shared";
import { decodeJwtPayloadWithoutVerifying, validateGitHubActionsOidcClaims } from "./oidc.js";
import { objectKeyForArtifact, type StoredSession } from "./session.js";
import { verifyUploadIntegrity } from "./upload-integrity.js";

export interface ApiServerOptions {
  host?: string;
  port?: number;
  storageDir?: string;
  publicUrl?: string;
  /** Development-only escape hatch for local CLI tests without GitHub OIDC. */
  allowDevAuth?: boolean;
  artifactStore?: ArtifactStore;
  oidcAudience?: string;
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4007;
  const storageDir = resolve(options.storageDir ?? ".chroma-snap/server");
  const artifactStore = options.artifactStore ?? new FileArtifactStore(storageDir);
  let publicUrl = options.publicUrl ?? `http://${host}:${port}`;
  await mkdir(storageDir, { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, { ...options, host, port, storageDir, publicUrl, artifactStore });
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  publicUrl = options.publicUrl ?? `http://${host}:${actualPort}`;
  return { server, url: publicUrl };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<ApiServerOptions, "host" | "port" | "storageDir" | "publicUrl" | "artifactStore">> & ApiServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", options.publicUrl);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/upload-sessions") {
    await assertUploadAuth(req, options);
    const body = await readJson<CreateUploadSessionRequest>(req);
    const session = await createUploadSession(body, options);
    sendJson(res, 201, session);
    return;
  }

  const uploadMatch = url.pathname.match(/^\/v1\/upload-sessions\/([^/]+)\/artifacts\/([^/]+)$/);
  if (req.method === "PUT" && uploadMatch) {
    const [, sessionId, artifactId] = uploadMatch;
    await putArtifact(req, options.storageDir, options.artifactStore, sessionId!, artifactId!);
    sendJson(res, 200, { ok: true });
    return;
  }

  const finalizeMatch = url.pathname.match(/^\/v1\/upload-sessions\/([^/]+)\/finalize$/);
  if (req.method === "POST" && finalizeMatch) {
    await assertUploadAuth(req, options);
    const body = await readJson<FinalizeUploadSessionRequest>(req);
    const response = await finalizeUploadSession(finalizeMatch[1]!, body, options);
    sendJson(res, 202, response);
    return;
  }

  const buildMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)$/);
  if (req.method === "GET" && buildMatch) {
    const build = await readJsonFile(resolve(options.storageDir, "builds", buildMatch[1]!, "build.json"));
    sendJson(res, 200, build);
    return;
  }

  throw new HttpError(404, "Not found");
}

async function createUploadSession(body: CreateUploadSessionRequest, options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl">> & ApiServerOptions): Promise<UploadSessionResponse> {
  if (!body.repository?.fullName || !body.git?.commitSha || !body.configHash) {
    throw new HttpError(400, "repository.fullName, git.commitSha, and configHash are required.");
  }

  const sessionId = randomUUID();
  const buildId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const session: StoredSession = {
    sessionId,
    buildId,
    createdAt: new Date().toISOString(),
    expiresAt,
    request: body,
    artifacts: (body.artifacts ?? []).map((artifact) => ({
      ...artifact,
      objectKey: objectKeyForArtifact(sessionId, artifact.id, body),
      status: "pending" as const,
    })),
    finalized: false,
  };

  await writeJsonFile(sessionPath(options.storageDir, sessionId), session);
  return {
    sessionId,
    buildId,
    expiresAt,
    uploadTargets: session.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      method: "PUT" as const,
      url: `${options.publicUrl}/v1/upload-sessions/${sessionId}/artifacts/${encodeURIComponent(artifact.id)}`,
      headers: { "content-type": artifact.contentType },
      objectKey: artifact.objectKey,
      expiresAt,
    })),
  };
}

async function putArtifact(req: IncomingMessage, storageDir: string, artifactStore: ArtifactStore, sessionId: string, artifactId: string): Promise<void> {
  const session = await readJsonFile<StoredSession>(sessionPath(storageDir, sessionId));
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    throw new HttpError(410, "Upload session expired.");
  }
  const artifact = session.artifacts.find((item) => item.id === artifactId);
  if (!artifact) {
    throw new HttpError(404, "Artifact is not part of this upload session.");
  }

  const stored = await artifactStore.putArtifact(artifact.objectKey, await readBody(req));
  artifact.status = "uploaded";
  artifact.actualSha256 = stored.sha256;
  artifact.actualByteSize = stored.byteSize;
  artifact.uploadedAt = new Date().toISOString();
  artifact.verificationError = undefined;
  await writeJsonFile(sessionPath(storageDir, sessionId), session);
}

async function finalizeUploadSession(
  sessionId: string,
  body: FinalizeUploadSessionRequest,
  options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl">> & ApiServerOptions,
): Promise<FinalizeUploadSessionResponse> {
  const session = await readJsonFile<StoredSession>(sessionPath(options.storageDir, sessionId));
  if (session.finalized) {
    return { buildId: session.buildId, status: "accepted", reportUrl: `${options.publicUrl}/v1/builds/${session.buildId}` };
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    throw new HttpError(410, "Upload session expired.");
  }

  assertValidManifest(body.manifest);
  if (body.manifest.repository.fullName !== session.request.repository.fullName) {
    throw new HttpError(400, "Manifest repository does not match upload session.");
  }
  if (body.manifest.git.commitSha !== session.request.git.commitSha) {
    throw new HttpError(400, "Manifest commit SHA does not match upload session.");
  }

  const integrity = await verifyUploadIntegrity(session, body.manifest, options.artifactStore!);
  await writeJsonFile(sessionPath(options.storageDir, sessionId), session);
  if (!integrity.ok) {
    throw new HttpError(400, `Artifact integrity check failed:\n${integrity.errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const buildDir = resolve(options.storageDir, "builds", session.buildId);
  await mkdir(buildDir, { recursive: true });
  await writeJsonFile(resolve(buildDir, "manifest.json"), body.manifest);
  await writeJsonFile(resolve(buildDir, "build.json"), {
    buildId: session.buildId,
    sessionId,
    repository: body.manifest.repository,
    git: body.manifest.git,
    project: body.manifest.project,
    status: "queued",
    createdAt: session.createdAt,
    finalizedAt: new Date().toISOString(),
  });
  await writeJsonFile(resolve(options.storageDir, "queue", `${session.buildId}.json`), {
    type: "diff-build",
    buildId: session.buildId,
    manifestPath: resolve(buildDir, "manifest.json"),
    enqueuedAt: new Date().toISOString(),
  });

  session.finalized = true;
  await writeJsonFile(sessionPath(options.storageDir, sessionId), session);

  return { buildId: session.buildId, status: "queued", reportUrl: `${options.publicUrl}/v1/builds/${session.buildId}` };
}

async function assertUploadAuth(req: IncomingMessage, options: ApiServerOptions): Promise<void> {
  if (options.allowDevAuth || process.env.CHROMA_SNAP_DEV_AUTH === "1") {
    return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw new HttpError(401, "Upload requires a GitHub Actions OIDC bearer token or CHROMA_SNAP_DEV_AUTH=1 for local development.");
  }

  const token = auth.slice("Bearer ".length);
  const claims = decodeJwtPayloadWithoutVerifying(token);
  const validation = validateGitHubActionsOidcClaims(claims, { audience: options.oidcAudience });
  if (!validation.ok) {
    throw new HttpError(401, validation.errors.join(" "));
  }

  // Production hosted deployment must verify the JWT signature against the GitHub Actions JWKS
  // and verify GitHub App installation access before reaching this point.
  if (process.env.CHROMA_SNAP_ALLOW_UNSIGNED_OIDC !== "1") {
    throw new HttpError(501, "OIDC claim parsing is present, but signature verification is not enabled in this local MVP. Set CHROMA_SNAP_ALLOW_UNSIGNED_OIDC=1 only for local testing.");
  }
}

function sessionPath(storageDir: string, sessionId: string): string {
  return resolve(storageDir, "sessions", `${sessionId}.json`);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(req)).toString("utf8")) as T;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonFile<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
