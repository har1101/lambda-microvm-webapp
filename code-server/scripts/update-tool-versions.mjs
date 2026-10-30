// Rewrites the pinned code-server and OMP versions (and their SHA-256s) in the
// MicroVM Dockerfile to the latest GitHub releases. Runs as `predeploy`: a changed Dockerfile changes the
// CodeArtifact asset hash, which makes cdkd rebuild the MicroVM image. When
// nothing is newer the file is left untouched and the image is not rebuilt.
import { readFileSync, writeFileSync } from 'node:fs';

const DOCKERFILE = new URL('../artifact/base-image/Dockerfile', import.meta.url);
const TIMEOUT_MS = 15_000;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'omp-cloud-ide-version-updater' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return response.json();
}

// Latest GitHub release of `repo` and the SHA-256 of its `assetName(version)`
// asset. GitHub records the digest of every uploaded release asset; the image
// build verifies the download against it.
async function latestReleaseAsset(repo, assetName) {
  const release = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const version = release.tag_name.replace(/^v/, '');
  const name = assetName(version);
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    throw new Error(`${repo} ${version} has no ${name} release asset`);
  }
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
  if (!sha256) {
    throw new Error(`${name}: release asset has no sha256 digest (${JSON.stringify(asset.digest)})`);
  }
  return { version, sha256 };
}

const [codeServer, omp] = await Promise.all([
  // The Dockerfile installs the arm64 RPM; refuse a release that does not ship it.
  latestReleaseAsset('coder/code-server', (version) => `code-server-${version}-arm64.rpm`),
  // The Dockerfile installs the standalone glibc arm64 binary.
  latestReleaseAsset('can1357/oh-my-pi', () => 'omp-linux-arm64'),
]);
const targets = {
  CODE_SERVER_VERSION: [codeServer.version, /^\d+\.\d+\.\d+$/],
  CODE_SERVER_ARM64_RPM_SHA256: [codeServer.sha256, /^[0-9a-f]{64}$/],
  OMP_VERSION: [omp.version, /^\d+\.\d+\.\d+$/],
  OMP_LINUX_ARM64_SHA256: [omp.sha256, /^[0-9a-f]{64}$/],
};

let dockerfile = readFileSync(DOCKERFILE, 'utf8');
for (const [arg, [value, format]] of Object.entries(targets)) {
  if (!format.test(value)) {
    throw new Error(`${arg}: unexpected value ${JSON.stringify(value)}`);
  }
  const line = new RegExp(`^ARG ${arg}=(.+)$`, 'm');
  const current = dockerfile.match(line)?.[1];
  if (current === undefined) {
    throw new Error(`ARG ${arg} not found in ${DOCKERFILE.pathname}`);
  }
  console.log(current === value ? `${arg} ${current} (latest)` : `${arg} ${current} -> ${value}`);
  dockerfile = dockerfile.replace(line, `ARG ${arg}=${value}`);
}
writeFileSync(DOCKERFILE, dockerfile);
