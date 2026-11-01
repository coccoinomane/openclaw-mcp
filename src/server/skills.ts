import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
const packagedRoot = new URL('../skills/', import.meta.url);
const root = existsSync(packagedRoot) ? packagedRoot : new URL('../../skills/', import.meta.url);
export function loadPackagedSkills() {
  return loadSkills(fileURLToPath(root), { strict: true });
}
export function skillResources(catalog: SkillCatalog) {
  return catalog.entries.map((skill) => ({
    uri: skill.uri,
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    mimeType: 'text/markdown',
  }));
}
export async function readSkillResource(catalog: SkillCatalog, uri: string) {
  // Only catalogued files; never translate arbitrary client paths to disk.
  for (const skill of catalog.entries) {
    const files = skill.resources;
    const entry = (Array.isArray(files) ? files : []).find((file) => file.uri === uri);
    if (!entry) continue;
    const relative = uri.replace('skill://', '');
    const bytes = await readFile(new URL(relative, root));
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    if (entry.digest !== digest)
      throw new Error('Skill resource changed; restart to reload catalog');
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: new TextDecoder().decode(bytes) }],
    };
  }
  throw new Error('Unknown skill resource');
}
