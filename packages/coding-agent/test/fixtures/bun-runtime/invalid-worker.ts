process.stdout.write(`${JSON.stringify({ version: 999, type: "ready", bunVersion: "test" })}\n`);
process.stdin.resume();
