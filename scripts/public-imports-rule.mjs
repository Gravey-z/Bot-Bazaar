import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);
const privatePackages =
  /^(?:@bot-bazaar\/worker|near-api-js|@near-js\/[^/]+|openai)(?:\/|$)/;
const privateDependencyPaths =
  /(?:^|\/)(?:near-api-js|@near-js\/[^/]+|openai)\//;
const publicPaths =
  /^(?:apps\/web\/src|packages\/(?:shared|chain)\/(?:src|dist))\//;

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      private:
        "Public code cannot import worker, operator, signing or provider infrastructure: {{source}}.",
      dynamic:
        "Public imports must use a literal module name so boundaries can be checked.",
      unresolved:
        "Cannot resolve public import {{source}}. Build workspace packages before checking boundaries.",
      environment:
        "Public modules must not read runtime environment variables.",
    },
  },
  create(context) {
    const filename = context.filename;
    const configPath = ts.findConfigFile(
      path.dirname(filename),
      ts.sys.fileExists,
    );
    const parsed =
      configPath &&
      ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(
              ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            );
          },
        },
      );

    function check(node, source) {
      if (typeof source !== "string") {
        context.report({ node, messageId: "dynamic" });
        return;
      }
      if (
        source.startsWith("node:") ||
        builtins.has(source) ||
        privatePackages.test(source)
      ) {
        context.report({ node, messageId: "private", data: { source } });
        return;
      }
      const resolved = ts.resolveModuleName(
        source,
        filename,
        parsed?.options ?? {},
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) {
        context.report({ node, messageId: "unresolved", data: { source } });
        return;
      }
      const relativePath = path
        .relative(workspaceRoot, resolved)
        .replaceAll("\\", "/")
        .toLowerCase();
      if (
        privateDependencyPaths.test(relativePath) ||
        (!relativePath.startsWith("node_modules/") &&
          !publicPaths.test(relativePath))
      ) {
        context.report({ node, messageId: "private", data: { source } });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        check(node, node.source.value);
      },
      TSImportType(node) {
        check(node, node.source.value);
      },
      TSImportEqualsDeclaration(node) {
        check(node, node.moduleReference.expression?.value);
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require"
        ) {
          check(node, node.arguments[0]?.value);
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "MetaProperty" &&
          (node.property.name === "env" || node.property.value === "env")
        ) {
          context.report({ node, messageId: "environment" });
        }
      },
    };
  },
};
