/**
 * Copy site/server/*.js into functions/server/ so deploy (which uploads only
 * functions/) includes the Express beacon API.
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "server");
const dest = path.join(__dirname, "..", "server");

if (!fs.existsSync(src)) {
  console.error(`sync-server: missing source dir ${src}`);
  process.exit(1);
}

fs.rmSync(dest, {recursive: true, force: true});
fs.mkdirSync(dest, {recursive: true});

for (const name of fs.readdirSync(src)) {
  if (!name.endsWith(".js")) continue;
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
}

console.log(`Synced ${src} -> ${dest}`);
