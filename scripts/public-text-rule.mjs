const unsafe =
  /^(?:innerHTML|outerHTML|srcdoc|insertAdjacentHTML|createContextualFragment|bypassSecurityTrust.*)$/i;

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      html: "Public text must use Angular interpolation or textContent; HTML sinks and sanitizer bypasses are forbidden.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = node.computed ? node.property.value : node.property.name;
        if (
          typeof name === "string" &&
          (unsafe.test(name) ||
            (["write", "writeln"].includes(name) &&
              node.object.name === "document"))
        )
          context.report({ node, messageId: "html" });
      },
    };
  },
};
