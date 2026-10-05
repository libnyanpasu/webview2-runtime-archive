import { assertEquals, assertThrows } from "@std/assert";
import { ARCHITECTURES, parseRuntimes } from "./downloads.ts";

const url = (version: string, arch: string) =>
  `https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/example/Microsoft.WebView2.FixedVersionRuntime.${version}.${arch}.cab`;
const page = (data: unknown) =>
  `<script type="application/json" id="__NUXT_DATA__">${
    JSON.stringify(data).replaceAll("/", "\\u002F")
  }</script>`;

Deno.test("extracts escaped Nuxt URLs, deduplicates and sorts versions numerically", () => {
  const versions = ["154.0.4258.62", "99.0.1.1", "153.0.4234.48"];
  const data = versions.flatMap((version) =>
    ARCHITECTURES.map((arch) => url(version, arch))
  );
  data.push(data[0], "https://example.com/bootstrapper.exe");
  const runtimes = parseRuntimes(page([["ShallowReactive", 1], data]));
  assertEquals(runtimes.map((r) => r.version), [
    "99.0.1.1",
    "153.0.4234.48",
    "154.0.4258.62",
  ]);
  assertEquals(runtimes[2].urls.x64, url(versions[0], "x64"));
});

Deno.test("fails explicitly when the page schema changes or no CABs exist", () => {
  assertThrows(
    () => parseRuntimes("<html></html>"),
    Error,
    "missing __NUXT_DATA__",
  );
  assertThrows(
    () => parseRuntimes(page(["https://example.com/installer.exe"])),
    Error,
    "No fixed-version",
  );
  assertThrows(
    () => parseRuntimes('<script id="__NUXT_DATA__">invalid</script>'),
    SyntaxError,
  );
});

Deno.test("rejects missing architectures, conflicting URLs and unexpected hosts", () => {
  const version = "154.0.4258.62";
  assertThrows(
    () => parseRuntimes(page([url(version, "x64")])),
    Error,
    "Missing arm64",
  );
  const urls = ARCHITECTURES.map((arch) => url(version, arch));
  assertThrows(
    () => parseRuntimes(page([...urls, urls[0].replace("example/", "other/")])),
    Error,
    "Conflicting",
  );
  assertThrows(
    () =>
      parseRuntimes(
        page(urls.map((u) =>
          u.replace("msedge.sf.dl.delivery.mp.microsoft.com", "example.com")
        )),
      ),
    Error,
    "Unexpected CAB host",
  );
});
