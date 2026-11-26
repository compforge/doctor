import { diagnosticMessage } from "../../../command/diagnostic";

// Match path segments as well as env names, including camelCase YAML properties.
const credentialKey = /(?:^|[._[\]-])(?:password|passwd|pwd|token|secret|credentials?|authorization|cookies?|api_?key|access_?key(?:_?id)?|private_?key|signing_?key|encryption_?key|ak|sk|dsn)(?:$|[._[\]-])/i;

export function sensitiveConfigKey(key: string): boolean {
  return credentialKey.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

export function redactConfigText(key: string, value: string): string {
  if (sensitiveConfigKey(key) || /-----BEGIN [^-]*PRIVATE KEY-----/.test(value)) return "[redacted]";
  // A JSON env value may itself hold an env list or a nested credential.
  if (/^\s*[[{]/.test(value) && !/^\[[\da-f:.%]+\](?::\d+)?$/i.test(value)) {
    try {
      let changed = false;
      const sanitized = JSON.stringify(JSON.parse(value), function (name, item: unknown) {
        const namedCredential = name === "value" && typeof this.name === "string" && sensitiveConfigKey(this.name);
        const safe = sensitiveConfigKey(name) || namedCredential ? "[redacted]"
          : typeof item === "string" ? redactConfigScalar(item) : item;
        if (safe !== item) changed = true;
        return safe;
      });
      return changed ? sanitized : value;
    } catch { return "[redacted]"; }
  }
  return redactConfigScalar(value);
}

function redactConfigScalar(value: string): string {
  if (/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+\S+/i.test(value)) return "[redacted]";
  return /:\/\/[^\s]*[@?#]|(?:password|passwd|token|api[_-]?key|secret)\s*[:=]/i.test(value)
    ? diagnosticMessage(value) : value;
}
