import "dotenv/config";
import { runSync } from "./sync/syncEngine.js";

try {
  const result = await runSync();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
