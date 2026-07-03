/**
 * Output discipline (Pipeline Spec): every stage returns JSON only. The parser
 * strips markdown fences / stray prose and extracts the first top-level JSON
 * object; schema validation happens downstream.
 */
export function extractJson(text: string): { value: unknown } | { error: string } {
  let candidate = text.trim();

  // ```json ... ``` or ``` ... ```
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidate = fence[1].trim();

  // Fall back to the outermost { ... } span if there's leading/trailing prose.
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return { error: 'no JSON object found in model output' };
    }
    candidate = candidate.slice(start, end + 1);
  }

  try {
    return { value: JSON.parse(candidate) };
  } catch (e) {
    return { error: `JSON parse failed: ${(e as Error).message}` };
  }
}
