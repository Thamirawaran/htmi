import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

/**
 * Package the built extension as a .vsix that VS Code installs with
 * "Extensions: Install from VSIX..." or `code --install-extension`. A .vsix
 * is a zip with a manifest; writing it here avoids a packaging dependency.
 * Run `npm run build` first; the bundle in dist/ is all the extension needs.
 */
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const out = join(here, `${pkg.name}-${pkg.version}.vsix`);

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Categories>${xml((pkg.categories ?? []).join(","))}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".cjs" ContentType="application/javascript" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".css" ContentType="text/css" />
</Types>
`;

// The installed package.json: what VS Code reads, without build scripts or development tools.
const { scripts: _scripts, devDependencies: _dev, ...installed } = pkg;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const entries = [
  ["[Content_Types].xml", Buffer.from(contentTypes)],
  ["extension.vsixmanifest", Buffer.from(manifest)],
  ["extension/package.json", Buffer.from(`${JSON.stringify(installed, null, 2)}\n`)],
  ...files(join(here, "dist")).map((f) => [`extension/${relative(here, f).split("\\").join("/")}`, readFileSync(f)]),
];
if (!entries.some(([name]) => name === "extension/dist/extension.cjs")) {
  throw new Error("dist/extension.cjs is missing; run npm run build first");
}

// A minimal zip writer: deflated entries, a central directory, no extras.
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const local = [];
const central = [];
let offset = 0;
for (const [name, data] of entries) {
  const nameBuf = Buffer.from(name, "utf8");
  const packed = deflateRawSync(data);
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(0, 10); // time and date fixed at 1980-01-01, so builds are reproducible
  head.writeUInt16LE(0x21, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  local.push(head, nameBuf, packed);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt16LE(0, 12);
  dir.writeUInt16LE(0x21, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);
  offset += head.length + nameBuf.length + packed.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`wrote ${relative(process.cwd(), out)} (${entries.length} files)`);
