import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import {
  checkTemplate,
  checkPublicTemplates,
} from "../../scripts/check-public-templates.mjs";

test("public templates keep hostile reason and URL strings in text bindings", () => {
  for (const value of [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "javascript:alert(1)",
    "https://evil.invalid/?token=private",
  ]) {
    const literal = JSON.stringify(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    const parsed = checkTemplate(`<p>{{ ${literal} }}</p>`);
    assert.equal(parsed.nodes.length, 1);
    const text = parsed.nodes[0].children[0];
    assert.equal(text.constructor.name, "BoundText");
    assert.equal(text.value.ast.expressions[0].value, value);
  }
});

test("HTML, srcdoc and embedded-document template sinks fail the build guard", () => {
  for (const template of [
    '<p [innerHTML]="reason"></p>',
    '<div [outerHTML]="reason"></div>',
    '<iframe [srcdoc]="reason"></iframe>',
    '<p [attr.innerHTML]="reason"></p>',
    '<object [data]="reason"></object>',
  ])
    assert.throws(() => checkTemplate(template));
});

test("public TypeScript rejects HTML assignments and Angular sanitizer bypasses", async () => {
  const eslint = new ESLint();
  for (const source of [
    "document.body.innerHTML = reason;",
    'document.body["outerHTML"] = reason;',
    'element.insertAdjacentHTML("beforeend", reason);',
    "sanitizer.bypassSecurityTrustHtml(reason);",
    "sanitizer.bypassSecurityTrustUrl(reason);",
    "document.write(reason);",
  ]) {
    const [result] = await eslint.lintText(source, {
      filePath: "apps/web/src/rendering-probe.ts",
    });
    assert.ok(
      result.messages.some((m) => m.ruleId === "rendering/public-text"),
      source,
    );
  }
  const [safe] = await eslint.lintText(
    'document.body.textContent = "<img src=x onerror=alert(1)>";',
    { filePath: "apps/web/src/rendering-probe.ts" },
  );
  assert.equal(safe.errorCount, 0);
});

test("all current consuming templates pass text-only rendering checks", async () => {
  await checkPublicTemplates();
});
