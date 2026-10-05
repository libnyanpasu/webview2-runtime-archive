import { retry } from "@std/async/retry";
import { Octokit } from "@octokit/rest";
import {
  ARCHITECTURES,
  discoverRuntimes,
  getFilename,
  type Runtime,
  WEBVIEW2_DOWNLOAD_URL,
} from "./downloads.ts";

export async function archiveRuntimes(
  octokit: Octokit,
  owner: string,
  repo: string,
  runtimes: Runtime[],
  download: typeof fetch = fetch,
): Promise<void> {
  // Oldest first, so the newest available runtime remains the latest release.
  for (const { version, urls } of runtimes) {
    let release;
    try {
      release = (await octokit.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag: version,
      }))
        .data;
    } catch (error) {
      if (
        !(error instanceof Error && "status" in error && error.status === 404)
      ) {
        throw error;
      }
      release = (await octokit.rest.repos.createRelease({
        owner,
        repo,
        tag_name: version,
        name: `WebView2 Runtime ${version}`,
        body:
          `Microsoft Edge WebView2 Runtime **${version}**\n\nFixed-version CAB packages for all architectures (x64, x86, arm64), downloaded from the [official Microsoft page](${WEBVIEW2_DOWNLOAD_URL}).`,
        draft: true,
        prerelease: false,
      })).data;
    }

    for (const arch of ARCHITECTURES) {
      const filename = getFilename(arch);
      await retry(async () => {
        // Recheck on retries: an upload may have succeeded despite a lost response.
        const assets = await octokit.paginate(
          octokit.rest.repos.listReleaseAssets,
          {
            owner,
            repo,
            release_id: release.id,
          },
        );
        const asset = assets.find((asset) => asset.name === filename);
        if (asset?.state === "uploaded" && asset.size > 0) {
          console.log(`${version}: ${filename} already uploaded`);
          return;
        }
        if (asset) {
          await octokit.rest.repos.deleteReleaseAsset({
            owner,
            repo,
            asset_id: asset.id,
          });
        }
        console.log(`${version}: downloading ${arch}...`);
        const response = await download(urls[arch]);
        if (!response.ok) {
          throw new Error(`CAB download returned ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        // CAB files begin with MSCF; reject HTML/error pages before uploading.
        if (
          data.length < 4 ||
          new TextDecoder().decode(data.subarray(0, 4)) !== "MSCF"
        ) {
          throw new Error(`Invalid CAB for ${version} ${arch}`);
        }
        await octokit.rest.repos.uploadReleaseAsset({
          owner,
          repo,
          release_id: release.id,
          name: filename,
          data: data as unknown as string,
          headers: { "content-type": "application/octet-stream" },
        });
        console.log(`${version}: uploaded ${filename} (${data.length} bytes)`);
      }, { maxAttempts: 3 });
    }

    if (release.draft) {
      await octokit.rest.repos.updateRelease({
        owner,
        repo,
        release_id: release.id,
        draft: false,
      });
    }
    console.log(`${version}: all three CAB packages archived`);
  }
}

if (import.meta.main) {
  const runtimes = await retry(discoverRuntimes, { maxAttempts: 3 });
  console.log(
    `Available WebView2 versions: ${runtimes.map((r) => r.version).join(", ")}`,
  );

  // Discovery can be verified without credentials or publishing releases.
  if (Deno.args.includes("--dry-run")) {
    console.log(JSON.stringify(runtimes, null, 2));
    Deno.exit(0);
  }

  const repository = Deno.env.get("GITHUB_REPOSITORY");
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!repository || !token || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(
      "GITHUB_REPOSITORY (owner/repo) and GITHUB_TOKEN are required",
    );
  }
  const [owner, repo] = repository.split("/");
  const octokit = new Octokit({ auth: token });

  await archiveRuntimes(octokit, owner, repo, runtimes);
}
