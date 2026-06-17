import JSZip from "jszip";
import { config, materialRoot } from "./config.js";
import { nowIso } from "./store.js";
import type { Store } from "./store.js";

function backupTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

export function backupFileName() {
  return `lesson-prep-backup-${backupTimestamp()}.zip`;
}

export async function createAppBackup(store: Store) {
  const zip = new JSZip();
  const generatedAt = nowIso();
  const manifest = {
    generatedAt,
    app: "lesson-prep-web",
    workspaceRoot: config.workspaceRoot,
    materialRoot,
    counts: {
      users: store.data.users.length,
      students: store.data.students.length,
      courses: store.data.courses.length,
      jobs: store.data.jobs.length,
      materials: store.data.materials.length,
      ragChunks: store.data.ragChunks.length
    },
    notes: [
      "This backup contains the application database snapshot.",
      "Generated lesson files and uploaded source files remain in PREP_WORKSPACE and should be backed up separately.",
      "Password hashes are included so the admin account can be restored with the database."
    ]
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("app-db.json", JSON.stringify(store.data, null, 2));
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}
