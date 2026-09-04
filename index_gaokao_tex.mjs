import { Store } from "./dist/server/store.js";
import { incrementalIndexMaterialRoot, getRagStats } from "./dist/server/rag.js";

const store = new Store();
const root = "/root/资料库";
const limit = process.argv[2] ? Number(process.argv[2]) : Infinity;
const result = await incrementalIndexMaterialRoot(store, root, limit, (p) => {
  if (p.processed % 25 === 0 || p.processed === p.total) {
    console.log(`progress: ${p.processed}/${p.total} indexed=${p.indexed} remaining=${p.remaining} current=${p.current || ""}`);
  }
});
const stats = getRagStats(store);
console.log("RESULT " + JSON.stringify({ ...result, stats }, null, 2));
