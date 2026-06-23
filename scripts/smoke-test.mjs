import { runSmokeTest } from "../src/smoke.mjs";

const result = await runSmokeTest({ keep: process.argv.includes("--keep") });
console.log(JSON.stringify(result, null, 2));
