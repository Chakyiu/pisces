import yaml from "js-yaml";

/** Present compose text as normalized YAML for the stack editor (mirrors backend `compose_for_editor`). */
export function composeForEditor(compose: string): string {
  try {
    const value = yaml.load(compose);
    if (value === undefined) {
      return compose;
    }
    return yaml.dump(value, { lineWidth: -1, noRefs: true }).replace(/\n?$/, "\n");
  } catch {
    return compose;
  }
}

export function composeYamlSyntaxError(value: string): string {
  if (!value.trim()) return "";
  try {
    yaml.load(value);
    return "";
  } catch {
    return "The Compose file is not valid YAML.";
  }
}