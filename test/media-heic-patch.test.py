import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('patcher', pathlib.Path(__file__).resolve().parents[1] / 'scripts/halman/patch-media-heic.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

SOURCE = '''import sharp from "sharp";
  private async generateStandardVariants(dir: string, buffer: Buffer, mediaType: string) {
    if (!mediaType.startsWith("image/")) return {};
    try {
      const specs = [{ name: "display", width: 1600 }];
      const output = await sharp(buffer, { limitInputPixels: 100_000_000 }).webp().toBuffer();
    } catch {
      return {};
    }
  }

  private collectionPath(id: string) { return id; }
'''


class PatchTests(unittest.TestCase):
    def test_decodes_variant_input_but_preserves_original(self):
        result = patcher.patch_storage(SOURCE)
        self.assertIn('sharp(imageBuffer,', result)
        self.assertIn('format: "PNG"', result)
        self.assertIn('if (isHeic) throw', result)
        self.assertNotIn('writeFile', result)

    def test_idempotent(self):
        result = patcher.patch_storage(SOURCE)
        self.assertEqual(result, patcher.patch_storage(result))

    def test_refuses_changed_or_ambiguous_sources(self):
        for source in (SOURCE.replace('const specs =', 'const sizes ='), SOURCE + SOURCE):
            with self.assertRaises(ValueError):
                patcher.patch_storage(source)
        with self.assertRaises(ValueError):
            patcher.patch_storage(patcher.MARKER + '\n' + SOURCE)


if __name__ == '__main__':
    unittest.main()
