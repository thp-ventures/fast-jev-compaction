import {copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const target = new URL('skills/jev-compact/scripts/engine/', root);
mkdirSync(target, {recursive: true});
for (const name of ['compact', 'state', 'request']) {
  const source = readFileSync(new URL(`dist/${name}.js`, root), 'utf8');
  writeFileSync(new URL(`${name}.js`, target), source.replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
}
copyFileSync(new URL('LICENSE', root), new URL('skills/jev-compact/LICENSE', root));
const pluginSkill = new URL('plugins/jev-compact/skills/jev-compact/', root);
rmSync(pluginSkill, {recursive: true, force: true});
cpSync(new URL('skills/jev-compact/', root), pluginSkill, {recursive: true});
