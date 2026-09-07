const { execFileSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const files = ["server.js", ...["public", "lib", "test", "scripts"].flatMap(dir => readdirSync(dir).filter(file => file.endsWith(".js")).map(file => dir + "/" + file))];
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log("Syntax checks passed: " + files.length + " JavaScript files");
