// Rewrites the pinned code-server and OMP versions in the MicroVM Dockerfile to
// the latest releases. Runs as `predeploy`: a changed Dockerfile changes the
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

async function latestCodeServer() {
  const release = await getJson('https://api.github.com/repos/coder/code-server/releases/latest');
  const version = release.tag_name.replace(/^v/, '');
  // The Dockerfile installs the arm64 RPM; refuse a release that does not ship it.
  const name = `code-server-${version}-arm64.rpm`;
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    throw new Error(`code-server ${version} has no ${name} release asset`);
  }
  // GitHub records the SHA-256 of every uploaded release asset; the image build verifies it.
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
  if (!sha256) {
    throw new Error(`${name}: release asset has no sha256 digest (${JSON.stringify(asset.digest)})`);
  }
  return { version, sha256 };
}

async function latestOmp() {
  const pkg = await getJson('https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest');
  return pkg.version;
}

const [codeServer, omp] = await Promise.all([latestCodeServer(), latestOmp()]);
const targets = {
  CODE_SERVER_VERSION: [codeServer.version, /^\d+\.\d+\.\d+$/],
  CODE_SERVER_ARM64_RPM_SHA256: [codeServer.sha256, /^[0-9a-f]{64}$/],
  OMP_VERSION: [omp, /^\d+\.\d+\.\d+$/],
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
