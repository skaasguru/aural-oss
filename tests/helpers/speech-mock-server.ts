import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  closedEarly: boolean;
}

export type MockHandler = (req: RecordedRequest, res: ServerResponse, index: number) => void | Promise<void>;

/** A real loopback HTTP server that records every request, for adapter integration tests. */
export async function startMockServer(handler: MockHandler): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    const record: RecordedRequest = { method: req.method || "", url: req.url || "", headers: req.headers, body: Buffer.alloc(0), closedEarly: false };
    res.on("close", () => { if (!res.writableEnded) record.closedEarly = true; });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      record.body = Buffer.concat(chunks);
      requests.push(record);
      Promise.resolve(handler(record, res, requests.length - 1)).catch(() => { res.statusCode = 500; res.end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse a multipart/form-data body into fields and files (enough for assertions). */
export function parseMultipart(contentType: string, body: Buffer): { fields: Record<string, string>; files: Record<string, { filename: string; contentType: string; data: Buffer }> } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) throw new Error(`not multipart: ${contentType}`);
  const delimiter = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; contentType: string; data: Buffer }> = {};
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const next = body.indexOf(delimiter, pos + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(pos + delimiter.length + 2, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, headerEnd).toString("utf8");
    const data = part.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(headers)?.[1] || "";
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    if (filename !== undefined) {
      files[name] = { filename, contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] || "", data };
    } else {
      fields[name] = data.toString("utf8");
    }
    pos = next;
  }
  return { fields, files };
}
