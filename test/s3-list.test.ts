import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { s3ListKeys, type S3Config } from "../apps/web/src/s3.ts";

it("lists every S3 page and refuses a truncated page without a cursor", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url.searchParams.get("continuation-token") ?? "");
    res.setHeader("Content-Type", "application/xml");
    if (requests.length === 1) res.end("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents><Key>quarantine/a/1</Key></Contents></ListBucketResult>");
    else if (requests.length === 2) res.end("<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>quarantine/a/2</Key></Contents></ListBucketResult>");
    else res.end("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config: S3Config = { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: "us-east-1", bucket: "test", accessKey: "synthetic", secretKey: "synthetic" };
  try {
    expect(await s3ListKeys(config, "quarantine/a/", 1)).toEqual(["quarantine/a/1", "quarantine/a/2"]);
    expect(requests).toEqual(["", "next"]);
    await expect(s3ListKeys(config, "quarantine/a/", 1)).rejects.toThrow("object list truncated");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
