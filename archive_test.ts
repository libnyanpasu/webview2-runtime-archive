import { assertEquals, assertRejects } from "@std/assert";
import { Octokit } from "@octokit/rest";
import { archiveRuntimes } from "./main.ts";
import { ARCHITECTURES, getFilename, type Runtime } from "./downloads.ts";

const runtime: Runtime = {
  version: "154.0.4258.62",
  urls: {
    arm64: "https://cab.test/arm64",
    x64: "https://cab.test/x64",
    x86: "https://cab.test/x86",
  },
};

function fixture(
  options: {
    exists?: boolean;
    draft?: boolean;
    assets?: string[];
    lookupStatus?: number;
    lostUploadResponse?: boolean;
    invalidCab?: boolean;
  } = {},
) {
  const events: string[] = [];
  const assets = (options.assets ?? []).map((name, id) => ({
    name,
    id,
    state: "uploaded",
    size: 100,
  }));
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  const release = { id: 1, draft: options.draft ?? true };
  let lost = false;
  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "cab.test") {
      events.push(`download:${url.pathname.slice(1)}`);
      return Promise.resolve(
        new Response(
          options.invalidCab ? "<html>error</html>" : "MSCFfake-cab",
        ),
      );
    }
    const path = url.pathname;
    if (path.includes("/tags/")) {
      return Promise.resolve(
        options.lookupStatus
          ? json({ message: "Lookup failed" }, options.lookupStatus)
          : options.exists
          ? json(release)
          : json({ message: "Not Found" }, 404),
      );
    }
    if (path.endsWith("/releases") && method === "POST") {
      assertEquals(JSON.parse(String(init?.body)).draft, true);
      events.push("create-draft");
      return Promise.resolve(json(release, 201));
    }
    if (path.endsWith("/assets") && method === "GET") {
      return Promise.resolve(json(assets));
    }
    if (path.endsWith("/assets") && method === "POST") {
      const name = url.searchParams.get("name")!;
      events.push(`upload:${name}`);
      const asset = {
        id: assets.length + 1,
        name,
        state: "uploaded",
        size: 100,
      };
      assets.push(asset);
      if (options.lostUploadResponse && !lost) {
        lost = true;
        return Promise.reject(new TypeError("Connection lost after upload"));
      }
      return Promise.resolve(json(asset, 201));
    }
    if (path.endsWith("/releases/1") && method === "PATCH") {
      assertEquals(assets.length, 3);
      assertEquals(JSON.parse(String(init?.body)).draft, false);
      events.push("publish");
      return Promise.resolve(json({ ...release, draft: false }));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const client = new Octokit({
    auth: "test-token",
    request: { fetch: fakeFetch },
  });
  return {
    events,
    run: () => archiveRuntimes(client, "owner", "repo", [runtime], fakeFetch),
  };
}

Deno.test("new release stays a draft until all three CABs are uploaded", async () => {
  const f = fixture();
  await f.run();
  assertEquals(f.events, [
    "create-draft",
    ...ARCHITECTURES.flatMap((
      arch,
    ) => [`download:${arch}`, `upload:${getFilename(arch)}`]),
    "publish",
  ]);
});

Deno.test("repairs an incomplete existing published release", async () => {
  const f = fixture({
    exists: true,
    draft: false,
    assets: [getFilename("arm64")],
  });
  await f.run();
  assertEquals(f.events, [
    "download:x64",
    `upload:${getFilename("x64")}`,
    "download:x86",
    `upload:${getFilename("x86")}`,
  ]);
});

Deno.test("complete release requires no downloads or mutations", async () => {
  const f = fixture({
    exists: true,
    draft: false,
    assets: ARCHITECTURES.map(getFilename),
  });
  await f.run();
  assertEquals(f.events, []);
});

Deno.test("upload response loss is recovered without duplicate uploads", async () => {
  const f = fixture({ exists: true, lostUploadResponse: true });
  await f.run();
  assertEquals(f.events.filter((e) => e.startsWith("upload:")).length, 3);
  assertEquals(f.events.at(-1), "publish");
});

Deno.test("authentication errors do not create releases", async () => {
  const f = fixture({ lookupStatus: 403 });
  await assertRejects(f.run, Error, "Lookup failed");
  assertEquals(f.events, []);
});

Deno.test("invalid CAB response is never uploaded or published", async () => {
  const f = fixture({ exists: true, invalidCab: true });
  const error = await assertRejects(f.run, Error, "maxAttempts");
  assertEquals(
    (error.cause as Error).message,
    "Invalid CAB for 154.0.4258.62 arm64",
  );
  assertEquals(
    f.events.filter((e) => e.startsWith("upload:") || e === "publish"),
    [],
  );
});
