import { indexMaterialFile } from "./rag.js";
import { Store } from "./store.js";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Missing file path.");
  process.exit(2);
}

try {
  const store = new Store();
  const material = await indexMaterialFile(store, filePath);
  process.stdout.write(JSON.stringify({ ok: true, material }) + "\n");
} catch (error) {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
