// Starts @zereight/mcp-gitlab with $ONESHOT_ARTIFACTS as its working directory.
// 2.2.4's upload_markdown reads file_path relative to the server's cwd and refuses absolute
// paths, `..` and symlinks; the SDK's McpStdioServerConfig has no `cwd`, so this shim sets it.
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const dir = process.env.ONESHOT_ARTIFACTS || process.cwd();
fs.mkdirSync(dir, { recursive: true });
process.chdir(dir);

// The package's `bin` entry; it is ESM and starts the stdio server on import.
import(pathToFileURL(require.resolve('@zereight/mcp-gitlab/build/index.js')).href).catch((err) => {
  process.stderr.write(`mcp-gitlab shim: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
