#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
const source = join(root, pin.source);
const tools = join(root, ".openagi/tools");
const mode = process.argv[2] ?? "prepare";
const bunVersion = pin.packageManager.slice("bun@".length);
const platform = {
  "darwin:arm64": "darwin-aarch64",
  "darwin:x64": "darwin-x64",
  "linux:arm64": "linux-aarch64",
  "linux:x64": "linux-x64",
  "win32:arm64": "windows-aarch64",
  "win32:x64": "windows-x64",
}[`${process.platform}:${process.arch}`];
if (!platform) throw new Error(`Unsupported build platform: ${process.platform}/${process.arch}`);
const bunPackage = `@oven/bun-${platform}`;
const bun = join(tools, "node_modules", bunPackage, "bin", process.platform === "win32" ? "bun.exe" : "bun");

function run(command, args, cwd = root, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}

async function ensureSource() {
  if (!existsSync(join(source, "package.json"))) {
    const checkout = join(root, ".openagi/upstream-opencode");
    if (!existsSync(join(checkout, ".git"))) {
      await mkdir(dirname(checkout), { recursive: true });
      run("git", ["clone", "--no-checkout", pin.repository, checkout]);
    }
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
    if (revision.stdout.trim() !== pin.commit || !existsSync(join(checkout, "package.json"))) {
      run("git", ["checkout", "--detach", pin.commit], checkout);
    }
    await mkdir(source, { recursive: true });
    for (const entry of await readdir(checkout)) {
      if ([".git", "node_modules", "dist"].includes(entry)) continue;
      await cp(join(checkout, entry), join(source, entry), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
      });
    }
  }
  // Existing vendored sources contain our integration. Preparation never replaces them.
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const hash = createHash("sha256").update(readFileSync(join(source, "bun.lock"))).digest("hex");
  if (manifest.version !== pin.version || hash !== pin.lockfileSha256) {
    throw new Error("Vendored OpenCode version or lockfile differs from upstream.json; update the pin deliberately.");
  }
}

async function ensureBun() {
  const current = existsSync(bun) && spawnSync(bun, ["--version"], { encoding: "utf8" });
  if (current && current.status === 0 && current.stdout.trim() === bunVersion) return;
  await mkdir(tools, { recursive: true });
  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install", "--prefix", tools, "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", `${bunPackage}@${bunVersion}`,
  ]);
}

function install() {
  run(bun, [
    "install", "--frozen-lockfile", "--filter", "@opencode/desktop", "--ignore-scripts",
    "--network-concurrency", "12", "--cache-dir", join(root, ".openagi/bun-cache"),
  ], source);
}

async function ensureWorkspaceHelpers() {
  // Upstream client typechecks include two helpers from otherwise unbuilt workspaces.
  // Reuse their already installed, locked dependencies without installing all Core or Storybook.
  for (const [consumer, owner, name] of [
    ["packages/storybook", "packages/app", "@playwright/test"],
    ["packages/core", "packages/desktop", "effect"],
    ["", "packages/client", "@tsconfig/bun"],
  ]) {
    const target = join(source, consumer, "node_modules", name);
    if (existsSync(target)) continue;
    const require = createRequire(join(source, owner, "package.json"));
    const dependency = dirname(require.resolve(`${name}/package.json`));
    await mkdir(dirname(target), { recursive: true });
    // A checkout moved on disk may retain a dangling absolute helper link.
    // Replace only symlinks, and keep new links relative to the checkout.
    try {
      if ((await lstat(target)).isSymbolicLink()) await unlink(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await symlink(relative(dirname(target), dependency), target, "dir");
  }
}

async function ensureDesktopElectron() {
  const require = createRequire(join(source, "packages/desktop/package.json"));
  const desktop = dirname(require.resolve("electron/package.json"));
  if (existsSync(join(desktop, "path.txt")) && existsSync(join(desktop, "dist"))) return;
  const localRequire = createRequire(join(root, "package.json"));
  let installed;
  try { installed = dirname(localRequire.resolve("electron/package.json")); } catch { /* Download below. */ }
  if (installed && existsSync(join(installed, "dist")) &&
      JSON.parse(readFileSync(join(installed, "package.json"))).version ===
      JSON.parse(readFileSync(join(desktop, "package.json"))).version) {
    await cp(join(installed, "dist"), join(desktop, "dist"), { recursive: true });
    await copyFile(join(installed, "path.txt"), join(desktop, "path.txt"));
  } else {
    // All workspace lifecycle scripts stay disabled. Only the pinned Electron binary is installed.
    run(process.execPath, [join(desktop, "install.js")], desktop);
  }
}

async function findCli(directory, packageName) {
  if (!existsSync(directory)) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(directory, entry.name, "node_modules", "@opencode", packageName);
    if (!existsSync(join(packageRoot, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const binary = join(packageRoot, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    if (manifest.name === `@opencode/${packageName}` && manifest.version === pin.version && existsSync(binary)) return binary;
  }
}

async function prepareResources() {
  const packages = {
    "darwin:arm64": "cli-darwin-arm64", "darwin:x64": "cli-darwin-x64-baseline",
    "linux:arm64": "cli-linux-arm64", "linux:x64": "cli-linux-x64-baseline",
    "win32:arm64": "cli-windows-arm64", "win32:x64": "cli-windows-x64-baseline",
  };
  const packageName = packages[`${process.platform}:${process.arch}`];
  let binary = await findCli(join(root, ".openagi/runtime/npm-cache/_npx"), packageName);
  if (!binary) {
    const cliRoot = join(root, ".openagi/upstream-cli");
    const packageRoot = join(cliRoot, "node_modules", "@opencode", packageName);
    const manifest = existsSync(join(packageRoot, "package.json")) && JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (!manifest || manifest.name !== `@opencode/${packageName}` || manifest.version !== pin.version) {
      run(process.platform === "win32" ? "npm.cmd" : "npm", [
        "install", "--prefix", cliRoot, "--ignore-scripts", "--save-exact", "--no-audit", "--no-fund", `@opencode/${packageName}@${pin.version}`,
      ]);
    }
    binary = join(packageRoot, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  }
  const desktop = join(source, "packages/desktop");
  const resources = join(desktop, "resources");
  await mkdir(resources, { recursive: true });
  const target = join(resources, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli");
  await copyFile(binary, target);
  if (process.platform !== "win32") await chmod(target, 0o755);
  await writeFile(join(resources, "opencode-cli.version"), pin.version + "\n");
  await cp(join(desktop, "icons/dev"), join(resources, "icons"), { recursive: true });
  // Native window/dock icons and renderer notifications must keep this product's identity.
  // Reuse the existing OpenAGI artwork; protocol and bundled execution binary names stay unchanged.
  const artwork = join(root, "desktop-assets");
  for (const [from, to] of [
    ["icon.png", "icon.png"], ["icon.png", "dock.png"], ["icon.icns", "icon.icns"],
    ["OpenAGI.iconset/icon_32x32.png", "32x32.png"],
    ["OpenAGI.iconset/icon_32x32@2x.png", "64x64.png"],
    ["OpenAGI.iconset/icon_128x128.png", "128x128.png"],
    ["OpenAGI.iconset/icon_128x128@2x.png", "128x128@2x.png"],
  ]) await copyFile(join(artwork, from), join(resources, "icons", to));
  const png = readFileSync(join(artwork, "OpenAGI.iconset/icon_256x256.png"));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // ICO, containing one 256×256 PNG image.
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  await writeFile(join(resources, "icons/icon.ico"), Buffer.concat([header, png]));
  await copyFile(join(artwork, "OpenAGI.iconset/icon_128x128@2x.png"), join(source, "packages/app/public/openagi-icon.png"));
}

if (!["prepare", "install", "resources", "build"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
await ensureSource();
await ensureBun();
if (["prepare", "install"].includes(mode)) install();
if (["prepare", "install"].includes(mode)) {
  await ensureWorkspaceHelpers();
  await ensureDesktopElectron();
}
if (mode !== "install") await prepareResources();
if (mode === "build") {
  const desktop = join(source, "packages/desktop");
  if (!existsSync(join(desktop, "node_modules/electron-vite"))) install();
  await ensureWorkspaceHelpers();
  await ensureDesktopElectron();
  run(process.execPath, [join(desktop, "node_modules/electron-vite/bin/electron-vite.js"), "build"], desktop, {
    OPENCODE_CHANNEL: "local",
    OPENCODE_VERSION: pin.version,
    PATH: `${dirname(bun)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  });
}
