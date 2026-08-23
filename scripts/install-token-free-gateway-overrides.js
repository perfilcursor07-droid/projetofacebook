const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'gateway-overrides', 'token-free-gateway');
const targetRoot = path.join(projectRoot, '.tools', 'token-free-gateway');
const required = process.argv.includes('--required');

const files = [
  'src/openai/chat-completions.ts',
  'src/openai/types.ts',
  'src/providers/claude/client.ts',
  'src/providers/claude/index.ts',
  'src/providers/claude/stream.ts',
  'src/providers/factory/base-api-client.ts',
  'src/providers/factory/types.ts',
  'src/providers/types.ts',
];

if (!fs.existsSync(path.join(targetRoot, 'package.json'))) {
  const message =
    '[gateway-sync] .tools/token-free-gateway não está instalado; overrides não aplicados.';
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

let updated = 0;
for (const relativePath of files) {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  if (!fs.existsSync(source)) {
    console.error(`[gateway-sync] override ausente: ${relativePath}`);
    process.exit(1);
  }

  const next = fs.readFileSync(source);
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (current && current.equals(next)) continue;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  updated += 1;
}

console.log(
  updated
    ? `[gateway-sync] ${updated} arquivo(s) do gateway atualizado(s).`
    : '[gateway-sync] gateway já está sincronizado.'
);
