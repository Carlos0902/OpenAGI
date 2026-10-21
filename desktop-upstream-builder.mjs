import upstream from "./vendor/opencode/packages/desktop/electron-builder.config.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const resources = fileURLToPath(new URL("./vendor/opencode/packages/desktop/resources/", import.meta.url));

export default {
  ...upstream,
  appId: "ai.openagi.desktop",
  productName: "OpenAGI",
  electronVersion: "44.4.5",
  directories: {
    ...upstream.directories,
    app: "vendor/opencode/packages/desktop",
    output: "release",
    buildResources: "vendor/opencode/packages/desktop/resources",
  },
  extraMetadata: { ...upstream.extraMetadata, name: "openagi-desktop", version, main: "out/main/index.js" },
  extraResources: [
    ...upstream.extraResources.map((entry) => ({ ...entry, from: resources })),
    { from: fileURLToPath(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url)), to: "THIRD_PARTY_NOTICES.md" },
    { from: fileURLToPath(new URL("./vendor/opencode/LICENSE", import.meta.url)), to: "OPENCODE_LICENSE" },
  ],
  protocols: { name: "OpenAGI", schemes: ["openagi"] },
  publish: null,
  mac: {
    ...upstream.mac,
    icon: "desktop-assets/icon.icns",
    identity: null,
    sign: undefined,
    notarize: false,
    hardenedRuntime: false,
    target: ["dir"],
  },
  linux: { ...upstream.linux, executableName: "openagi", target: ["dir"] },
  win: { ...upstream.win, target: ["dir"] },
};
