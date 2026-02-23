import { launch } from "jsr:@astral/astral";
import { retry } from "jsr:@std/async@1/retry";
import { Octokit } from "npm:@octokit/rest";

const WEBVIEW2_DOWNLOAD_URL =
  "https://developer.microsoft.com/en-us/microsoft-edge/webview2";

const GITHUB_REPOSITORY = Deno.env.get("GITHUB_REPOSITORY");
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN");

if (!GITHUB_REPOSITORY || !GITHUB_TOKEN) {
  console.error(
    "Missing required environment variables: GITHUB_REPOSITORY, GITHUB_TOKEN",
  );
  Deno.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split("/");
const octokit = new Octokit({ auth: GITHUB_TOKEN });

enum WEBVIEW2_ARCH {
  ARM64 = "arm64",
  X64 = "x64",
  X86 = "x86",
}

const getFilename = (arch: WEBVIEW2_ARCH): string =>
  `Microsoft.WebView2.FixedVersionRuntime.${arch}.cab`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Check if a release with the given version tag already exists */
const checkReleaseExists = async (version: string): Promise<boolean> => {
  try {
    await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: version });
    return true;
  } catch {
    return false;
  }
};

/** Create a new GitHub Release and return its id */
const createRelease = async (version: string): Promise<number> => {
  const { data } = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: version,
    name: `WebView2 Runtime ${version}`,
    body: `Microsoft Edge WebView2 Runtime **${version}**\n\nInstallers for all architectures (x64, x86, arm64), downloaded from the [official Microsoft page](${WEBVIEW2_DOWNLOAD_URL}).`,
    draft: false,
    prerelease: false,
  });
  return data.id;
};

/** Upload a binary file as a release asset */
const uploadReleaseAsset = async (
  releaseId: number,
  filename: string,
  data: Uint8Array,
): Promise<void> => {
  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: filename,
    // Octokit types expect string, but accepts Uint8Array at runtime
    data: data as unknown as string,
    headers: { "content-type": "application/octet-stream" },
  });
  console.log(
    `  Uploaded: ${filename} (${(data.length / 1024 / 1024).toFixed(1)} MB)`,
  );
};

/** Download a URL into memory */
const downloadFile = async (url: string): Promise<Uint8Array> => {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
};

// Browser scraping
const browser = await launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ],
});

const page = await browser.newPage(WEBVIEW2_DOWNLOAD_URL, {
  waitUntil: "none",
});

const getVersion = async (): Promise<string> => {
  const versionFieldDiv = await page.waitForSelector(
    'div.block-webview2__field:has(> label[for="version"])',
  );
  const versionFieldSelect =
    await versionFieldDiv.waitForSelector(`button[id="version"]`);
  return await versionFieldSelect.innerText();
};

const version = await getVersion();
console.log(`WebView2 version: ${version}`);

// Check for duplicate release before doing any more work
console.log(`Checking if release "${version}" already exists...`);
if (await checkReleaseExists(version)) {
  console.log(`Release "${version}" already exists. Nothing to do.`);
  await browser.close();
  Deno.exit(0);
}
console.log(`Release "${version}" not found — proceeding.`);

// Scrape download URLs for every architecture
const getArchFieldSelector = async () => {
  const archFieldDiv = await page.waitForSelector(
    'div.block-webview2__field:has(> label[for="architecture"])',
  );
  return await archFieldDiv.waitForSelector(`button[id="architecture"]`);
};

const selectArch = async (arch: WEBVIEW2_ARCH): Promise<string> => {
  const archFieldSelect = await getArchFieldSelector();
  await archFieldSelect.click();
  await sleep(1000);

  await page.waitForSelector("button.px-dropdown__item");

  const archFieldItems = await page.$$("button.px-dropdown__item");
  let targetItem = null;

  for (const item of archFieldItems) {
    const text = (await item.innerText()).trim().toLowerCase();
    if (text === arch.toLowerCase()) {
      targetItem = item;
      break;
    }
  }

  if (!targetItem) {
    throw new Error(`Architecture option not found: ${arch}`);
  }

  await targetItem.click();
  await sleep(1000);

  const finalArchFieldSelect = await getArchFieldSelector();
  return await finalArchFieldSelect.innerText();
};

const getDownloadUrl = async (arch: WEBVIEW2_ARCH): Promise<string> => {
  await selectArch(arch);

  const downloadButton = await page.waitForSelector(
    "button.common-button.common-button--icon-after.block-webview2__download-button.block-webview2__download-button",
  );
  await downloadButton.click();
  await sleep(1000);

  const downloadLink = await page.$(
    "a.common-button-v1.common-button-v1--null.webview-eula-popup__button.webview-eula-popup__button",
  );

  const href = await downloadLink!.getAttribute("href");
  if (!href) {
    throw new Error("Download link not found");
  }

  return href;
};

const urls = {} as Record<WEBVIEW2_ARCH, string>;

for (const arch of Object.values(WEBVIEW2_ARCH)) {
  urls[arch] = await retry(
    async () => {
      console.log(`  Getting download URL for ${arch}...`);
      return await getDownloadUrl(arch);
    },
    { maxAttempts: 5 },
  );
  console.log(`  ${arch}: ${urls[arch]}`);
}

await browser.close();

// Download files, create release, upload assets
console.log(`\nCreating GitHub release "${version}"...`);
const releaseId = await createRelease(version);
console.log(`Release created (id=${releaseId}).`);

for (const arch of Object.values(WEBVIEW2_ARCH)) {
  const url = urls[arch];
  const filename = getFilename(arch);

  console.log(`\nDownloading ${arch}...`);
  const fileData = await retry(() => downloadFile(url), { maxAttempts: 3 });

  await retry(() => uploadReleaseAsset(releaseId, filename, fileData), {
    maxAttempts: 3,
  });
}

console.log(`\nDone! Release "${version}" published successfully.`);
