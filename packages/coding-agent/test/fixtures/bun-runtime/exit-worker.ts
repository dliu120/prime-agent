process.stdout.write(`${JSON.stringify({ version: 1, type: "ready", bunVersion: "test" })}\n`);
process.stdin.once("data", () => process.exit(23));
process.stdin.resume();
