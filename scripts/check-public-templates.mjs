import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import ts from "typescript";

const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { parseTemplate } = await import(
  pathToFileURL(webRequire.resolve("@angular/compiler")).href
);
const unsafe = /^(?:innerHTML|outerHTML|srcdoc)$/i;

export function checkTemplate(source, name = "public template") {
  const parsed = parseTemplate(source, name);
  if (parsed.errors?.length)
    throw new Error("Public template cannot be parsed");
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (typeof node.name === "string" && unsafe.test(node.name))
      throw new Error(
        "Public templates must render untrusted text with interpolation, without HTML bindings",
      );
    if (
      typeof node.name === "string" &&
      /^(script|iframe|object|embed)$/i.test(node.name) &&
      Array.isArray(node.children)
    )
      throw new Error("Public templates cannot embed executable documents");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  parsed.nodes.forEach(visit);
  return parsed;
}

export async function checkPublicTemplates(
  root = fileURLToPath(new URL("../apps/web/src", import.meta.url)),
) {
  for (const file of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!file.isFile() || !/\.(html|ts)$/.test(file.name)) continue;
    const path = join(file.parentPath, file.name),
      source = await readFile(path, "utf8");
    if (file.name.endsWith(".html")) checkTemplate(source, path);
    else {
      const ast = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const walk = (node) => {
        if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(ast).replace(/['"]/g, "") === "template"
        ) {
          if (
            !ts.isStringLiteral(node.initializer) &&
            !ts.isNoSubstitutionTemplateLiteral(node.initializer)
          )
            throw new Error("Public inline templates must be literal text");
          checkTemplate(node.initializer.text, path);
        }
        ts.forEachChild(node, walk);
      };
      walk(ast);
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await checkPublicTemplates();
  console.info("Public templates use text rendering without HTML sinks");
}
