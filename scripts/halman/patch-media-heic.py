#!/usr/bin/env python3
"""Guarded patch for the HALMAN Media source supplied on 2026-10-04."""
import json
import pathlib
import sys

MARKER = 'const convertHeic = createRequire(import.meta.url)("heic-convert");'


def patch_storage(source):
    if MARKER in source:
        if source.count('const output = await sharp(imageBuffer,') != 1 or source.count('if (isHeic) throw new Error("HEIC web-variant conversion failed"') != 1:
            raise ValueError("Incomplete Media HEIC patch; refusing to proceed")
        return source
    import_anchor = 'import sharp from "sharp";'
    method_anchor = '''    if (!mediaType.startsWith("image/")) return {};
    try {
      const specs ='''
    variant_anchor = 'const output = await sharp(buffer, { limitInputPixels:'
    catch_anchor = '''    } catch {
      return {};
    }
  }

  private collectionPath'''
    for anchor in (import_anchor, method_anchor, variant_anchor, catch_anchor):
        if source.count(anchor) != 1:
            raise ValueError("Media storage source has changed; refusing an unsafe patch")
    source = source.replace(import_anchor, import_anchor + '\nimport { createRequire } from "node:module";\n\n' + MARKER)
    source = source.replace(method_anchor, '''    if (!mediaType.startsWith("image/")) return {};
    const isHeic = /^image\\/hei[cf]$/i.test(mediaType);
    try {
      // Preserve the uploaded original. Decode only the web-variant input:
      // bundled Sharp/libvips may recognise HEIC but lack a working HEVC decoder.
      const imageBuffer = isHeic
        ? Buffer.from(await convertHeic({ buffer, format: "PNG" }))
        : buffer;
      const specs =''')
    source = source.replace(variant_anchor, 'const output = await sharp(imageBuffer, { limitInputPixels:')
    source = source.replace(catch_anchor, '''    } catch (error) {
      // Do not report a successful HEIC upload with unusable web variants.
      if (isHeic) throw new Error("HEIC web-variant conversion failed", { cause: error });
      console.error("Media web-variant conversion failed", error);
      return {};
    }
  }

  private collectionPath''')
    return source


def main():
    app = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/volume1/docker/ashterix-media/app')
    storage = app / 'src/storage.ts'
    package = app / 'package.json'
    source = storage.read_text()
    patched = patch_storage(source)  # Validate all anchors before changing anything.
    manifest = json.loads(package.read_text())
    manifest.setdefault('dependencies', {})['heic-convert'] = '2.1.0'
    for file in (storage, package, app / 'package-lock.json'):
        backup = file.with_name(file.name + '.before-heic-support')
        if file.exists() and not backup.exists():
            backup.write_bytes(file.read_bytes())
    storage.write_text(patched)
    package.write_text(json.dumps(manifest, indent=2) + '\n')
    print('Media HEIC source patched; originals and access rules unchanged.')


if __name__ == '__main__':
    main()
