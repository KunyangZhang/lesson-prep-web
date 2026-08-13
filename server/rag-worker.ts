import { indexMaterialFile } from "./rag.js";
import { Store } from "./store.js";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Missing file path.");
  process.exit(2);
}

try {
  // The parent server owns app-db.json. The worker only updates the SQLite
  // index and returns the material record for the parent to persist.
  const store = new Store(undefined, { persist: false });
  const material = await indexMaterialFile(store, filePath);
  process.stdout.write(JSON.stringify({ ok: true, material }) + "\n");
  process.exit(0);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
