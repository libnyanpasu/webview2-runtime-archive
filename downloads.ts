export const WEBVIEW2_DOWNLOAD_URL =
  "https://developer.microsoft.com/en-us/microsoft-edge/webview2";
export const ARCHITECTURES = ["arm64", "x64", "x86"] as const;
export type Architecture = typeof ARCHITECTURES[number];
export interface Runtime {
  version: string;
  urls: Record<Architecture, string>;
}

export const getFilename = (arch: Architecture): string =>
  `Microsoft.WebView2.FixedVersionRuntime.${arch}.cab`;

/** Read CAB URLs from Microsoft's server-rendered Nuxt payload, without hydration. */
export function parseRuntimes(html: string): Runtime[] {
  const payload = html.match(
    /<script\b[^>]*\bid=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!payload) throw new Error("Microsoft page is missing __NUXT_DATA__");
  const data: unknown = JSON.parse(payload[1]);
  const runtimes = new Map<string, Partial<Record<Architecture, string>>>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    } else if (typeof value === "string" && value.startsWith("https://")) {
      const url = new URL(value);
      const match = url.pathname.match(
        /\/Microsoft\.WebView2\.FixedVersionRuntime\.(\d+\.\d+\.\d+\.\d+)\.(arm64|x64|x86)\.cab$/,
      );
      if (!match) return;
      if (url.hostname !== "msedge.sf.dl.delivery.mp.microsoft.com") {
        throw new Error(`Unexpected CAB host: ${url.hostname}`);
      }
      const [, version, arch] = match;
      const urls = runtimes.get(version) ?? {};
      if (urls[arch as Architecture] && urls[arch as Architecture] !== value) {
        throw new Error(`Conflicting CAB URLs for ${version} ${arch}`);
      }
      urls[arch as Architecture] = value;
      runtimes.set(version, urls);
    }
  }
  visit(data);
  if (!runtimes.size) throw new Error("No fixed-version CAB URLs found");
  return [...runtimes].map(([version, urls]) => {
    for (const arch of ARCHITECTURES) {
      if (!urls[arch]) throw new Error(`Missing ${arch} CAB for ${version}`);
    }
    return { version, urls: urls as Runtime["urls"] };
  }).sort((a, b) => {
    const left = a.version.split(".").map(Number);
    const right = b.version.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  });
}

export async function discoverRuntimes(): Promise<Runtime[]> {
  const response = await fetch(WEBVIEW2_DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Microsoft page returned ${response.status}`);
  }
  return parseRuntimes(await response.text());
}
