import { ClientManager } from "@compforge/harness-toolbox/client-manager";
import { S3DataSource } from "@compforge/harness-toolbox/s3";

/** Local S3 protocol fixture: exercises the installed toolbox SDK without live infrastructure. */
export async function startS3Fixture(respond: (url: string, request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => respond(request.url, request),
  });
  const clients = new ClientManager();
  const target = {
    endpoint: server.url.toString(),
    region: "us-east-1",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
    forcePathStyle: true,
  };
  try {
    const client = await clients.get(new S3DataSource(target, {
      concurrency: 2, connectTimeoutMs: 1000, requestTimeoutMs: 2000,
    }));
    return { client, target, async close() {
      await clients.dispose();
      await server.stop(true);
    } };
  } catch (error) {
    await clients.dispose();
    await server.stop(true);
    throw error;
  }
}
