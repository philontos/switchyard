import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const MIRRORS_DIR = path.join(DATA_DIR, "mirrors");
export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
export const DB_PATH = path.join(DATA_DIR, "dispatcher.db");
export const WEB_DIR = path.join(ROOT, "web");
