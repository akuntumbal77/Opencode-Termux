#!/usr/bin/env bun
/**
 * Build OpenCode for Android (aarch64).
 *
 * Bun cannot directly --compile for Android, so this script builds a Linux
 * standalone binary with host Bun, extracts its module graph, then appends that
 * graph to the Android Bun runtime built by this project.
 */

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OPENCODE_DIR = process.env.OPENCODE_DIR || (() => { throw new Error("OPENCODE_DIR env var not set") })()
const ANDROID_BUN = process.env.ANDROID_BUN || (() => { throw new Error("ANDROID_BUN env var not set") })()
const OUTPUT_DIR = process.env.OUTPUT_DIR || (() => { throw new Error("OUTPUT_DIR env var not set") })()

if (!fs.existsSync(ANDROID_BUN)) {
  console.error("Android bun binary not found at:", ANDROID_BUN)
  process.exit(1)
}

process.chdir(OPENCODE_DIR)

const VERSION = process.env.OPENCODE_VERSION || "1.18.34"
const CHANNEL = process.env.OPENCODE_CHANNEL || "latest"

console.log(`Building OpenCode v${VERSION} (channel: ${CHANNEL}) for Android aarch64`)

console.log("\n=== Step 1: Loading models.dev snapshot ===")
const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
let modelsData = ""
if (process.env.MODELS_DEV_API_JSON) {
  modelsData = await Bun.file(process.env.MODELS_DEV_API_JSON).text()
} else {
  let fetchErr: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${modelsUrl}/api.json`, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      modelsData = await resp.text()
      fetchErr = null
      break
    } catch (err: any) {
      fetchErr = err
      console.error(`  Attempt ${attempt}/3 failed: ${err.message}`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  if (fetchErr) {
    console.error(`ERROR: Failed to fetch models after 3 attempts: ${fetchErr.message}`)
    process.exit(1)
  }
}
JSON.parse(modelsData)
console.log("Loaded models.dev snapshot")

console.log("\n=== Step 2: Resolving OpenTUI workers ===")
const localPath = path.resolve(OPENCODE_DIR, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(OPENCODE_DIR, "../../node_modules/@opentui/core/parser.worker.js")
let parserWorkerResolved: string
try {
  parserWorkerResolved = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
} catch {
  parserWorkerResolved = require.resolve("@opentui/core/parser.worker.js")
}
const workerPath = "./src/cli/tui/worker.ts"
console.log(`Parser worker: ${parserWorkerResolved}`)
console.log(`OpenCode worker: ${workerPath}`)

await $`rm -rf ${OUTPUT_DIR}`
await $`mkdir -p ${OUTPUT_DIR}`

console.log("\n=== Step 3: Bundling OpenCode ===")
const hostBinaryPath = path.join(OUTPUT_DIR, "opencode-host")
const plugin = createSolidTransformPlugin()

// The bundle emitted `import "undici"` with the namespace binding dropped, so
// effect's Undici module ran `__reExport(exports, undici)` and crashed with
// "undici is not defined". Resolve "undici" to a small self-contained shim built
// from the runtime's own fetch globals instead of leaving it as a bare import.
//
// NOTE: in the builds we have inspected this hook never fired -- the emitted
// graph still contains `import Undici from"undici"`, i.e. Bun maps `undici`
// (like `ws`) to its own builtin thirdparty module before plugin onResolve
// runs, and the runtime resolves it to builtin://thirdparty/undici. The shim is
// kept as a fallback; the authoritative fix is the module-graph patch in Step 5.
const undiciShim = {
  name: "undici-shim",
  setup(build: any) {
    build.onResolve({ filter: /^undici$/ }, () => ({ path: "undici", namespace: "undici-shim" }))
    build.onLoad({ filter: /.*/, namespace: "undici-shim" }, () => ({
      loader: "js",
      contents: `
        const g = globalThis;
        const unsupported = (name) => class { constructor() { throw new Error("undici." + name + " is not available in this build"); } };
        export const fetch = (...a) => g.fetch(...a);
        export const Headers = g.Headers;
        export const Request = g.Request;
        export const Response = g.Response;
        export const FormData = g.FormData;
        export const WebSocket = g.WebSocket;
        export const MessageEvent = g.MessageEvent;
        export const CloseEvent = g.CloseEvent;
        export const EventSource = g.EventSource;
        export const Dispatcher = unsupported("Dispatcher");
        export const Agent = unsupported("Agent");
        export const ProxyAgent = unsupported("ProxyAgent");
        export const EnvHttpProxyAgent = unsupported("EnvHttpProxyAgent");
        export const setGlobalDispatcher = () => {};
        export const getGlobalDispatcher = () => undefined;
        export default { fetch, Headers, Request, Response, FormData, WebSocket, MessageEvent, CloseEvent, EventSource, Dispatcher, Agent, ProxyAgent, EnvHttpProxyAgent, setGlobalDispatcher, getGlobalDispatcher };
      `,
    }))
  },
}
const bunfsRoot = "/$bunfs/root/"
const workerRelativePath = path.relative(OPENCODE_DIR, parserWorkerResolved).replaceAll("\\", "/")

const result = await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin, undiciShim],
  external: ["node-gyp"],
  format: "esm",
  // Identifier mangling produced an undeclared symbol at runtime ("aOj is not defined").
  // Keep whitespace/syntax minification but leave identifiers alone unless
  // OPENCODE_MINIFY_IDENTIFIERS=1; error messages also become readable.
  minify: { whitespace: true, syntax: true, identifiers: process.env.OPENCODE_MINIFY_IDENTIFIERS === "1" },
  sourcemap: "none",
  // Cross-chunk imports break at runtime on the Android Bun 1.2.13 runtime
  // ("OX is not a function" from a chunk import). Bundle without chunk splitting
  // unless OPENCODE_SPLITTING=1 is set.
  splitting: process.env.OPENCODE_SPLITTING === "1",
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    outfile: hostBinaryPath,
    execArgv: [`--user-agent=opencode/${VERSION}`, "--use-system-ca", "--"],
  },
  entrypoints: ["./src/index.ts", parserWorkerResolved, workerPath],
  define: {
    FFF_LIBC: `"gnu"`,
    OPENCODE_VERSION: `'${VERSION}'`,
    OPENCODE_MODELS_DEV: modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'${CHANNEL}'`,
    OPENCODE_LIBC: `"glibc"`,
    "process.env.OPENTUI_LIBC": `"glibc"`,
  },
})

if (!result.success) {
  console.error("Build failed:")
  for (const msg of result.logs) console.error(msg)
  process.exit(1)
}
console.log(`Host standalone binary: ${hostBinaryPath}`)

console.log("\n=== Step 4: Extracting module graph ===")
const hostBytes = new Uint8Array(await Bun.file(hostBinaryPath).arrayBuffer())
const hostBuf = Buffer.from(hostBytes.buffer, hostBytes.byteOffset, hostBytes.length)
const trailer = Buffer.from("\n---- Bun! ----\n")
const trailerEnd = hostBytes.length - 8
const trailerStart = trailerEnd - trailer.length
if (hostBuf.compare(trailer, 0, trailer.length, trailerStart, trailerEnd) !== 0) {
  console.error("ERROR: Bun standalone trailer not found at expected position")
  console.error("       The standalone binary format may have changed.")
  process.exit(1)
}
const offsetsSize = 32
const offsetsStart = trailerStart - offsetsSize
const offsetsByteCount = Number(hostBuf.readBigUInt64LE(offsetsStart))
const moduleGraphSize = offsetsByteCount + offsetsSize + trailer.length
const hostBunSize = hostBytes.length - 8 - moduleGraphSize
if (hostBunSize <= 0) {
  console.error(`ERROR: Derived host bun size is ${hostBunSize}`)
  process.exit(1)
}
let moduleGraph = Buffer.from(hostBytes.slice(hostBunSize, hostBytes.length - 8))
console.log(`Host standalone size: ${hostBytes.length}`)
console.log(`Derived host bun size: ${hostBunSize}`)
console.log(`Module graph size: ${moduleGraph.length}`)

console.log("\n=== Step 5: Patching module graph for Android ===")
const mgOffsetsStart = moduleGraph.length - trailer.length - offsetsSize
const modOff = moduleGraph.readUInt32LE(mgOffsetsStart + 8)
const modLen = moduleGraph.readUInt32LE(mgOffsetsStart + 12)
console.log(`String data region: [0, ${modOff}), Module list bytes: ${modLen}`)

// Bun's bundler keeps the external default import (`import Undici from
// "undici"`) but drops the namespace binding, leaving the body reference
// `__reExport(exports_Undici, undici)` -- which throws "ReferenceError: undici
// is not defined" as soon as @effect/platform-node's index initializes its
// Undici module. Re-point that reference at the default import, which the
// runtime resolves to Bun's builtin thirdparty/undici (fetch + dispatcher
// classes).
//
// Two hard constraints on this patch:
//  1. It must be byte-length preserving. The string data region is addressed
//     by absolute StringPointers in the module list, and the file ends with a
//     total_byte_count footer; growing/shrinking the region corrupts both.
//     `undici` -> `Undici` is 6 -> 6 bytes, so only the token is swapped.
//  2. It must be whitespace tolerant. minify.whitespace strips the space after
//     the comma, so the previous fixed-string search for
//     "__reExport(exports_Undici, undici)" matched 0 occurrences, only printed
//     a warning, and shipped a binary that crashed on startup.
const strDataRegion = moduleGraph.subarray(0, modOff)
let undiciPatchCount = 0
const patchedRegionStr = strDataRegion
  .toString("latin1")
  .replace(/__reExport\(([\w$]+)(\s*,\s*)undici\)/g, (_match, ident: string, sep: string) => {
    undiciPatchCount++
    return `__reExport(${ident}${sep}Undici)`
  })
const patchedRegion = Buffer.from(patchedRegionStr, "latin1")
if (patchedRegion.length !== modOff) {
  console.error(`ERROR: undici patch changed the string region size (${modOff} -> ${patchedRegion.length})`)
  process.exit(1)
}
patchedRegion.copy(moduleGraph, 0)

if (undiciPatchCount === 0) {
  console.warn("WARNING: no __reExport(<ident>, undici) occurrence found in the module graph")
  console.warn("         The bundler output may have changed; check for a bare 'undici' identifier manually")
} else {
  console.log(`Patched ${undiciPatchCount} undici occurrence(s)`)
}

// Fail loudly instead of shipping a binary that crashes with
// "ReferenceError: undici is not defined".
if (/__reExport\([\w$]+\s*,\s*undici\)/.test(patchedRegionStr)) {
  console.error("ERROR: unpatched __reExport(..., undici) reference still present in the module graph")
  process.exit(1)
}

console.log("\n=== Step 6: Creating Android standalone binary ===")
const androidBunBytes = new Uint8Array(await Bun.file(ANDROID_BUN).arrayBuffer())
const outputSize = androidBunBytes.length + moduleGraph.length + 8
const output = new Uint8Array(outputSize)
output.set(androidBunBytes, 0)
output.set(new Uint8Array(moduleGraph.buffer, moduleGraph.byteOffset, moduleGraph.length), androidBunBytes.length)

const totalView = new DataView(output.buffer, outputSize - 8, 8)
totalView.setUint32(0, outputSize & 0xffffffff, true)
totalView.setUint32(4, Math.floor(outputSize / 0x100000000), true)

const androidOutputPath = path.join(OUTPUT_DIR, "opencode")
await Bun.write(androidOutputPath, output)
fs.chmodSync(androidOutputPath, 0o755)
console.log(`Android standalone binary: ${androidOutputPath}`)
console.log(`Size: ${(outputSize / 1024 / 1024).toFixed(1)} MB`)

console.log("\n=== Step 7: Verifying output ===")
const verifyBytes = new Uint8Array(await Bun.file(androidOutputPath).arrayBuffer())
const verifyView = new DataView(verifyBytes.buffer, verifyBytes.length - 8, 8)
const verifyTotal = verifyView.getUint32(0, true) + verifyView.getUint32(4, true) * 0x100000000
console.log(`total_byte_count=${verifyTotal}, file_size=${verifyBytes.length}, match=${verifyTotal === verifyBytes.length}`)
if (verifyTotal !== verifyBytes.length) process.exit(1)

const elfMagic = String.fromCharCode(verifyBytes[0], verifyBytes[1], verifyBytes[2], verifyBytes[3])
console.log(`ELF magic: ${elfMagic === "\x7fELF" ? "OK" : "INVALID"}`)
if (elfMagic !== "\x7fELF") process.exit(1)

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]
const EM_AARCH64 = 0xb7
const EM_X86_64 = 0x3e
const EM_X86 = 0x03
let foundElfCount = 0
let foundX64 = false
let foundX86 = false
for (let i = 0; i < verifyBytes.length - 20; i++) {
  if (
    verifyBytes[i] === ELF_MAGIC[0] &&
    verifyBytes[i + 1] === ELF_MAGIC[1] &&
    verifyBytes[i + 2] === ELF_MAGIC[2] &&
    verifyBytes[i + 3] === ELF_MAGIC[3]
  ) {
    foundElfCount++
    const machine = verifyBytes[i + 18] | (verifyBytes[i + 19] << 8)
    if (machine === EM_X86_64) foundX64 = true
    if (machine === EM_X86) foundX86 = true
    console.log(
      `  ELF at offset ${i}: ${
        machine === EM_AARCH64 ? "aarch64" : machine === EM_X86_64 ? "x86_64" : machine === EM_X86 ? "x86" : `machine=0x${machine.toString(16)}`
      }`,
    )
  }
}
console.log(`Found ${foundElfCount} embedded ELF image(s)`)
if (foundX64 || foundX86) {
  console.warn("WARNING: Embedded x86/x86_64 ELF files detected.")
  console.warn("         Usually this is host bun-pty and is ignored unless BUN_PTY_LIB points at it.")
}

console.log("\n=== Build complete! ===")
console.log(`Output: ${androidOutputPath}`)
