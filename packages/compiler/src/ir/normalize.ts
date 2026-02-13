import type { AppDefinition, UIComponent } from "@form-builder/contracts";

const VAR_TOKEN_REGEX = /{{\s*([^}]+?)\s*}}/g;

function normalizeKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "");
}

function buildAliasMap(components: UIComponent[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const component of components) {
    if (component.type === "TextArea") {
      aliases.set(component.stateKey, component.stateKey);
      aliases.set(component.label, component.stateKey);
      aliases.set(normalizeKey(component.stateKey), component.stateKey);
      aliases.set(normalizeKey(component.label), component.stateKey);
    }
  }
  return aliases;
}

function canonicalVar(raw: string, aliases: Map<string, string>): string {
  return aliases.get(raw) ?? aliases.get(normalizeKey(raw)) ?? raw;
}

function normalizeTemplate(template: string, aliases: Map<string, string>): string {
  return template.replace(VAR_TOKEN_REGEX, (_match, raw) => {
    const value = String(raw).trim();
    return `{{${canonicalVar(value, aliases)}}}`;
  });
}

export function normalizeToIR(app: AppDefinition): AppDefinition {
  const aliases = buildAliasMap(app.ui.components);

  const normalizedEvents = app.events.map((event) => ({
    ...event,
    actionGraph: {
      ...event.actionGraph,
      nodes: event.actionGraph.nodes.map((node) => {
        if (node.kind !== "PromptTask") {
          return node;
        }

        return {
          ...node,
          promptSpec: {
            ...node.promptSpec,
            template: normalizeTemplate(node.promptSpec.template, aliases),
            variables: node.promptSpec.variables.map((variable) => canonicalVar(variable, aliases)),
          },
        };
      }),
    },
  }));

  return {
    ...app,
    events: normalizedEvents,
  };
}
