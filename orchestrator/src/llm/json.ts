/**
 * Output discipline (Pipeline Spec): every stage returns JSON only. Models
 * occasionally wrap it in fences or prose anyway, so extraction is layered:
 * direct parse → fenced block → string-aware balanced-brace scan (handles
 * prose containing '{', trailing commentary, and ``` inside string values).
 * Schema validation happens downstream.
 */
export function extractJson(text: string): { value: unknown } | { error: string } {
  const tryParse = (s: string): { value: unknown } | null => {
    try {
      return { value: JSON.parse(s) };
    } catch {
      return null;
    }
  };

  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }

  // Balanced scan: from each '{', walk to its matching '}' (string-aware) and
  // try to parse that span. First successful parse wins.
  for (let start = trimmed.indexOf('{'); start !== -1; start = trimmed.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = inString;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(trimmed.slice(start, i + 1));
          if (candidate) return candidate;
          break; // this '{' didn't yield valid JSON; try the next one
        }
      }
    }
  }

  return { error: 'no parseable JSON object found in model output' };
}
