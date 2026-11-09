import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

async function runtimeSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter((e) => e.name !== '__tests__')
      .map(async (e) => {
        const path = join(dir, e.name);
        return e.isDirectory() ? runtimeSources(path) : path.endsWith('.ts') ? [path] : [];
      })
  );
  return paths.flat();
}

describe('runtime has no OpenClaw CLI capability', () => {
  it('contains no subprocess modules, launch primitives or removed transport settings', async () => {
    const files = await runtimeSources(new URL('../../', import.meta.url).pathname);
    expect(files.length).toBeGreaterThan(30);
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          expect(node.moduleSpecifier.text, path).not.toMatch(
            /^(?:node:)?(?:child_process|cluster)$/
          );
        }
        if (ts.isCallExpression(node)) {
          const called = node.expression;
          const name = ts.isIdentifier(called)
            ? called.text
            : ts.isPropertyAccessExpression(called)
              ? called.name.text
              : undefined;
          const regexExec =
            ts.isPropertyAccessExpression(called) &&
            called.expression.kind === ts.SyntaxKind.RegularExpressionLiteral;
          expect(
            !regexExec &&
              [
                'exec',
                'execFile',
                'execSync',
                'execFileSync',
                'spawn',
                'spawnSync',
                'fork',
              ].includes(name ?? ''),
            path
          ).toBe(false);
          if (
            (name === 'require' || called.kind === ts.SyntaxKind.ImportKeyword) &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            expect(node.arguments[0].text, path).not.toMatch(
              /^(?:node:)?(?:child_process|cluster)$/
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      expect(source, path).not.toMatch(
        /child_process|node:cluster|from ['"](?:execa|cross-spawn|shelljs)['"]/
      );
      expect(source, path).not.toMatch(
        /(?:execFile|execSync|spawnSync|spawn|fork|runCli|CatalogRunner|CliRunner)[ (]/
      );
      expect(source, path).not.toMatch(
        /MCP_DISCORD_(?:AGENT_TRANSPORT|EXECUTABLE|CLI_|GATEWAY_READS_ENABLED|THREAD_CREATE_MODE)|MCP_AGENT_DISCOVERY_(?:EXECUTABLE|INSTANCE)/
      );
      expect(source, path).not.toContain('--message-file');
      expect([...new TextEncoder().encode(source)], path).not.toContain(0);
    }
  });
});
