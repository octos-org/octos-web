interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** GFM literal autolinks consume CJK sentence punctuation as URL characters. */
export function remarkSourceLinks() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const pending = [tree];
    while (pending.length) {
      const parent = pending.pop()!;
      const children = parent.children;
      if (!children) continue;
      for (let index = 0; index < children.length; index++) {
        const node = children[index];
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (node.type === "link" && node.url && start !== undefined && end !== undefined) {
          const literal = source.slice(start, end);
          // Inspect source syntax: explicit [links](url), <autolinks>, and
          // percent-encoded punctuation may intentionally name such a path.
          if (/^(?:https?:\/\/|www\.)/i.test(literal)) {
            const suffix = literal.match(/[，。；：！？、）］｝】》〉」』”’]+$/)?.[0];
            if (suffix && node.children?.length === 1 && node.children[0].type === "text") {
              const text = node.children[0];
              if (text.value?.endsWith(suffix)) {
                const trimmed = literal.slice(0, -suffix.length);
                node.url = /^www\./i.test(trimmed) ? `http://${trimmed}` : trimmed;
                text.value = text.value.slice(0, -suffix.length);
                children.splice(index + 1, 0, { type: "text", value: suffix });
                index++;
              }
            }
          }
        }
        pending.push(node);
      }
    }
  };
}
